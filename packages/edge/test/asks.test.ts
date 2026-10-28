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
  decide(
    id: string,
    decision: "approved" | "denied",
    by: object,
    seen?: string | null,
  ): Promise<{ ok: boolean; error?: string }>;
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
  // One right makes the circle an agent circle of the machine (K-1730); "adds apps" stays off.
  const stub = await setup({ deploys: { mode: "automatic" } });
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
  // The event insert reads its AUTOINCREMENT counter, and the trim to 5,000 reads its last id.
  expect(
    await counted((instance) => instance.webSocketMessage(daemonSocket(sent), message("allow"))),
  ).toBeLessThanOrEqual(4);
  const proposalReads = await counted((instance) =>
    instance.webSocketMessage(daemonSocket(sent), message("deploy")),
  );
  // The proposal itself reads nothing; the alarm schedule reads its next due items (jobs, retries, the expiry).
  expect(proposalReads).toBeLessThanOrEqual(20);
});

it("ends an approval that is no longer allowed, and refuses one for a text that the approver did not read (K-1712, K-1722)", async () => {
  const stub = await setup({ deploys: { mode: "ask", circleId: "owner" } });
  const waiting = await ask(stub, "deploy", "card");
  const id = waiting.outcome === "waiting" ? waiting.proposalId : "";
  const approve = (seen: string | null) =>
    runInDurableObject(stub, (instance) =>
      (instance as unknown as Instance).decide(id, "approved", owner, seen),
    );
  expect(await approve("0".repeat(64))).toMatchObject({
    ok: false,
    error: expect.stringContaining("changed"),
  });
  // The owner turns the right to automatic meanwhile: the ask no longer asks this circle.
  await setup({ deploys: { mode: "automatic" } });
  await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec(
      `INSERT INTO proposals (id, machine_id, action, target, body, reason, labels, right_name, circle_id, shown, shown_hash, state, created_at, expires_at)
       VALUES ('p1', 'vps', 'deploy', 'card', 'null', NULL, '{}', 'deploys', 'owner', 'deploy card', 'h', 'pending', 0, ?)`,
      Date.now() + 60_000,
    ),
  );
  const late = await runInDurableObject(stub, (instance) =>
    (instance as unknown as Instance).decide("p1", "approved", owner, null),
  );
  expect(late).toMatchObject({ ok: false, error: expect.stringContaining("no longer allowed") });
});

it("refuses a new ask past 20 open asks of one machine (K-1722)", async () => {
  const stub = await setup({ deploys: { mode: "ask", circleId: "owner" } });
  for (let at = 0; at < 20; at++)
    expect(await ask(stub, "deploy", `card-${at}`)).toMatchObject({ outcome: "waiting" });
  expect(await ask(stub, "deploy", "card-20")).toEqual({
    outcome: "refused",
    reason: expect.stringContaining("20 open asks"),
  });
});

it("lets only an owner email resume, also when an approver policy let another person in (K-1504)", async () => {
  const stub = await setup({});
  await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('paused', 'keep-public')"),
  );
  await evictDurableObject(stub);
  const resume = (email: string) =>
    runInDurableObject(stub, async (instance) => {
      const response = (instance as unknown as { resume(caller: object): Response }).resume({
        actor: { _tag: "person", email },
        visitor: { email, clientId: null, ip: null },
      });
      return response.status;
    });
  expect(await resume("approver@example.com")).toBe(403);
  expect(await resume("owner@example.com")).toBe(200);
});

it("refuses an approve of a passkey circle that came through the login path, and an ask too long to read (K-1723, K-1722)", async () => {
  const stub = await setup({ deploys: { mode: "ask", circleId: "owner" } });
  const waiting = await ask(stub, "deploy", "card");
  const id = waiting.outcome === "waiting" ? waiting.proposalId : "";
  const viaLogin = await runInDurableObject(stub, (instance) =>
    (
      instance as unknown as {
        decide(
          id: string,
          d: string,
          by: object,
          seen: string | null,
          via: string,
        ): Promise<{ ok: boolean; error?: string }>;
      }
    ).decide(id, "approved", owner, null, "login"),
  );
  // The seeded Owner circle needs a passkey.
  expect(viaLogin).toMatchObject({ ok: false, error: expect.stringContaining("needs a passkey") });
});

it("refuses an ask whose text is too long for an approver to read (K-1722)", async () => {
  const stub = await setup({ runsCommands: { mode: "ask", circleId: "owner" } });
  expect(
    await ask(stub, "job", "vps", { body: { command: { kind: "shell", script: "x".repeat(5000) } } }),
  ).toEqual({ outcome: "refused", reason: expect.stringContaining("too long") });
});
