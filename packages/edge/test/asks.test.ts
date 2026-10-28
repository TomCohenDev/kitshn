import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { AskOutcome, Machine, ServerToDaemon } from "../src/core/machine.ts";
import type { Circle, RightMode } from "../src/core/model.ts";

afterEach(() => vi.restoreAllMocks());

const machine: Machine = {
  id: "vps",
  name: "vps",
  labels: [],
  order: 0,
  serviceTokenId: "token-vps",
  clientId: "vps.access",
  tunnelId: "tunnel-vps",
};

/** A daemon socket of a machine that passed its key check (K-1704); it keeps what kitshn sends. */
const daemonSocket = (sent: Array<ServerToDaemon>) =>
  ({
    deserializeAttachment: () => ({
      kind: "machine",
      machineId: "vps",
      since: 0,
      challenge: "",
      check: "signed",
      answered: true,
      rotateBy: null,
      status: null,
      sample: null,
    }),
    serializeAttachment() {},
    send: (text: string) => sent.push(JSON.parse(text) as ServerToDaemon),
    close() {},
  }) as unknown as WebSocket;

/** One map where the machine vps sits in the agent circle "agents" with these rights. */
async function setup(rights: Partial<Record<string, RightMode>>) {
  const stub = env.KITSHN.getByName("kitshn");
  const agents: Circle = {
    id: "agents",
    name: "Agents",
    color: "#ffcc00",
    level: "control",
    members: [{ _tag: "machine", machineId: "vps", rights }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 5000,
    y: 5000,
    r: 200,
  };
  await runInDurableObject(stub, (_, state) => {
    // The tests share one Durable Object, so each starts from the same machine, circle and empty asks.
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO machines (id, body) VALUES (?, ?)",
      "vps",
      JSON.stringify(machine),
    );
    state.storage.sql.exec("DELETE FROM proposals");
    state.storage.sql.exec("DELETE FROM ask_events");
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO circles (id, body) VALUES (?, ?)",
      "agents",
      JSON.stringify(agents),
    );
  });
  await evictDurableObject(stub);
  return stub;
}

type Instance = {
  webSocketMessage(socket: WebSocket, text: string): Promise<void>;
  decide(id: string, decision: "approved" | "denied", by: object): Promise<{ ok: boolean; error?: string }>;
  expireProposals(now: number): void;
};

async function ask(stub: DurableObjectStub, action: string, target = "", extra: object = {}) {
  const sent: Array<ServerToDaemon> = [];
  await runInDurableObject(stub, (instance) =>
    (instance as unknown as Instance).webSocketMessage(
      daemonSocket(sent),
      JSON.stringify({ type: "ask", requestId: "r1", ask: { action, target, ...extra } }),
    ),
  );
  const answer = sent.find((message) => message.type === "askAnswer");
  if (!answer) throw new Error("kitshn sent no askAnswer.");
  const {
    type: _type,
    requestId: _id,
    ...outcome
  } = answer as Extract<ServerToDaemon, { type: "askAnswer" }>;
  return outcome as AskOutcome;
}

const owner = {
  actor: { _tag: "person", email: "owner@example.com" },
  visitor: { email: "owner@example.com", clientId: null, ip: null },
  machineId: null,
  reason: null,
};

it("refuses a right that is off, and names it (K-1720)", async () => {
  const stub = await setup({});
  expect(await ask(stub, "allow", "123")).toEqual({
    outcome: "refused",
    reason: expect.stringContaining('"adds apps" is off'),
  });
  // `state` needs no right.
  expect(await ask(stub, "state")).toMatchObject({ outcome: "done" });
});

it("refuses bad labels and asks during the pause (K-1750, K-1504)", async () => {
  const stub = await setup({});
  expect(await ask(stub, "state", "", { labels: { nokey: "x" } })).toMatchObject({ outcome: "refused" });
  await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('paused', 'keep-public')"),
  );
  await evictDurableObject(stub);
  expect(await ask(stub, "state")).toEqual({ outcome: "refused", reason: expect.stringContaining("paused") });
  await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec("DELETE FROM meta WHERE key = 'paused'"),
  );
  await evictDurableObject(stub);
});

it("waits for one answer of its approver circle; a second answer gets already decided (K-1722, K-1723)", async () => {
  const stub = await setup({ deploys: { mode: "ask", circleId: "owner" } });
  const waiting = await ask(stub, "deploy", "card", { reason: "test" });
  expect(waiting).toMatchObject({ outcome: "waiting" });
  const id = waiting.outcome === "waiting" ? waiting.proposalId : "";
  const decide = (by: object) =>
    runInDurableObject(stub, (instance) => (instance as unknown as Instance).decide(id, "denied", by));
  // A machine outside the approver circle does not answer.
  expect(
    await decide({ ...owner, visitor: { email: null, clientId: "vps.access", ip: null }, machineId: "vps" }),
  ).toMatchObject({ ok: false, error: expect.stringContaining("approver circle") });
  expect(await decide(owner)).toEqual({ ok: true });
  expect(await decide(owner)).toMatchObject({ ok: false, error: expect.stringContaining("already decided") });
  const states = await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec<{ state: string }>("SELECT state FROM proposals").toArray(),
  );
  expect(states).toEqual([{ state: "denied" }]);
});

it("expires a proposal after its time, so no later answer runs it (K-1724)", async () => {
  const stub = await setup({ deploys: { mode: "ask", circleId: "owner" } });
  const waiting = await ask(stub, "deploy", "card");
  const id = waiting.outcome === "waiting" ? waiting.proposalId : "";
  await runInDurableObject(stub, (instance) =>
    (instance as unknown as Instance).expireProposals(Date.now() + 25 * 60 * 60_000),
  );
  const late = await runInDurableObject(stub, (instance) =>
    (instance as unknown as Instance).decide(id, "approved", owner),
  );
  expect(late).toMatchObject({ ok: false, error: expect.stringContaining("already decided") });
});

it("writes one ask event for each ask, not a revision (K-1717)", async () => {
  const stub = await setup({});
  await ask(stub, "allow", "123");
  const events = await runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<{ action: string; outcome: string }>("SELECT action, outcome FROM ask_events")
      .toArray(),
  );
  expect(events).toEqual([{ action: "allow", outcome: "refused" }]);
});

it("reads only what its own event write reads for a refused ask, and a few rows for a new proposal (K-1715)", async () => {
  const stub = await setup({ deploys: { mode: "ask", circleId: "owner" } });
  // Wake the object first, so its load does not count.
  await ask(stub, "allow", "123");
  const counted = async (run: (instance: Instance) => Promise<unknown>) =>
    runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      const exec = sql.exec.bind(sql);
      let rowsRead = 0;
      sql.exec = ((query: string, ...bindings: Array<SqlStorageValue>) => {
        const cursor = exec(query, ...bindings);
        const toArray = cursor.toArray.bind(cursor);
        cursor.toArray = () => {
          const rows = toArray();
          rowsRead += cursor.rowsRead;
          return rows;
        };
        return cursor;
      }) as typeof sql.exec;
      try {
        await run(instance as unknown as Instance);
      } finally {
        sql.exec = exec;
      }
      return rowsRead;
    });
  const sent: Array<ServerToDaemon> = [];
  const message = (action: string) =>
    JSON.stringify({ type: "ask", requestId: "r", ask: { action, target: "card" } });
  // The event insert reads its AUTOINCREMENT counter.
  expect(
    await counted((instance) => instance.webSocketMessage(daemonSocket(sent), message("allow"))),
  ).toBeLessThanOrEqual(2);
  const proposalReads = await counted((instance) =>
    instance.webSocketMessage(daemonSocket(sent), message("deploy")),
  );
  // The proposal itself reads nothing; the alarm schedule reads its next due items (jobs, retries, the expiry).
  expect(proposalReads).toBeLessThanOrEqual(20);
});
