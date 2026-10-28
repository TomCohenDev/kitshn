import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { AskOutcome, Machine, ServerToDaemon } from "../src/core/machine.ts";
import type { Circle, Resource, RightMode } from "../src/core/model.ts";

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

/** The machine in the agent circle "agents" with these rights, and an owner group of Yarden-zamir inside it. */
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
  const group: Resource = {
    id: "repo-group-yarden-zamir",
    kind: "repo.group",
    name: "Yarden-zamir",
    addresses: [],
    status: "unknown",
    group: null,
    machine: null,
    match: "Yarden-zamir",
    githubWay: "app",
  };
  await runInDurableObject(stub, (_, state) => {
    const sql = state.storage.sql;
    sql.exec("INSERT OR REPLACE INTO machines (id, body) VALUES (?, ?)", "vps", JSON.stringify(machine));
    sql.exec("INSERT OR REPLACE INTO circles (id, body) VALUES (?, ?)", "agents", JSON.stringify(agents));
    sql.exec("INSERT OR REPLACE INTO resources (id, body) VALUES (?, ?)", group.id, JSON.stringify(group));
    sql.exec("INSERT OR REPLACE INTO places (id, x, y) VALUES (?, 5000, 5000)", group.id);
  });
  await evictDurableObject(stub);
  return stub;
}

/** A fake GitHub: the installation of the repo, a token, and its revocation. */
function fakeGitHub() {
  const calls: Array<string> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === "/repos/Yarden-zamir/riffle/installation") return Response.json({ id: 7 });
    if (url.pathname === "/app/installations/7/access_tokens")
      return Response.json({ token: "ghs_test", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (url.pathname === "/installation/token") return new Response(null, { status: 204 });
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  return calls;
}

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

async function askToken(stub: DurableObjectStub, repo: string) {
  const sent: Array<ServerToDaemon> = [];
  await runInDurableObject(stub, (instance) =>
    (instance as unknown as { webSocketMessage(s: WebSocket, t: string): Promise<void> }).webSocketMessage(
      daemonSocket(sent),
      JSON.stringify({
        type: "ask",
        requestId: "r",
        ask: { action: "github-token", target: repo, body: { permission: "auto" } },
      }),
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

it("gives a write token for one repo of an App owner, and revokes it when the key resets (K-1762, K-1716)", async () => {
  const calls = fakeGitHub();
  const stub = await setup({ writesCode: { mode: "automatic" } });
  expect(await askToken(stub, "Yarden-zamir/riffle")).toEqual({
    outcome: "done",
    result: { token: "ghs_test", expiresAt: expect.any(String), permission: "write" },
  });
  expect(calls).toContain("POST /app/installations/7/access_tokens");
  await runInDurableObject(stub, (instance) =>
    (instance as unknown as { denyOpenProposals(id: string, why: string): void }).denyOpenProposals(
      "vps",
      "reset",
    ),
  );
  expect(calls).toContain("DELETE /installation/token");
});

it("answers not kitshn for another owner, and refuses an App owner's repo without a right (K-1760, K-1733)", async () => {
  fakeGitHub();
  const stub = await setup({});
  expect(await askToken(stub, "qlik-trial/app")).toMatchObject({ outcome: "not-kitshn" });
  expect(await askToken(stub, "Yarden-zamir/riffle")).toMatchObject({
    outcome: "refused",
    reason: expect.stringContaining('"reads code" is off'),
  });
});
