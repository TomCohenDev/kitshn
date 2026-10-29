import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ProviderReport } from "@kitshn/local";
import { afterEach, expect, it, vi } from "vitest";
import type { Machine } from "../src/core/machine.ts";
import { type Circle, OWNER_CIRCLE_ID, type Resource, providerCardId } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

const machine: Machine = {
  id: "vps",
  name: "vps",
  labels: [],
  order: 0,
  serviceTokenId: "token-vps",
  clientId: "vps.access",
  tunnelId: "tunnel-vps",
};

/** A daemon socket of the machine: signed (K-1704), or on its token alone (K-1708). */
const daemonSocket = (check: "signed" | "token", sent: Array<unknown> = []) =>
  ({
    deserializeAttachment: () => ({
      kind: "machine",
      machineId: machine.id,
      since: 0,
      challenge: "",
      check,
      answered: true,
      rotateBy: null,
      status: null,
      sample: null,
    }),
    serializeAttachment() {},
    send(text: string) {
      sent.push(JSON.parse(text));
    },
    close() {},
  }) as unknown as WebSocket;

const report = (resources: ProviderReport["resources"], online = true): ProviderReport => ({
  name: "t3",
  online,
  kinds: [{ id: "t3.app", name: "T3 app", levels: { view: "view", use: "use", control: "control" } }],
  commands: [{ id: "restart", title: "Restart server", kinds: ["t3.app"], confirm: true }],
  resources,
});
const app = { id: "app", kind: "t3.app", name: "T3 on vps", status: "running" } as const;
const appId = providerCardId("vps", "t3", "app");

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup() {
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (_, state) => {
    // The tests of this file share one Durable Object, so each starts without the cards of the one before.
    state.storage.sql.exec("DELETE FROM resources WHERE id LIKE 'p-%' OR id = 'other'");
    state.storage.sql.exec("DELETE FROM places WHERE id LIKE 'p-%'");
    state.storage.sql.exec("DELETE FROM providers");
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO machines (id, body) VALUES (?, ?)",
      "vps",
      JSON.stringify(machine),
    );
    // The machine card sits in the Owner circle, so the owner has control on it (K-614).
    const owner = JSON.parse(
      state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = ?", OWNER_CIRCLE_ID).one()
        .body,
    ) as Circle;
    const card: Resource = {
      id: "vps",
      kind: "machine",
      name: "vps",
      addresses: [],
      status: "running",
      group: null,
      machine: "vps",
    };
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO resources (id, body) VALUES (?, ?)",
      "vps",
      JSON.stringify(card),
    );
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO places (id, x, y) VALUES (?, ?, ?)",
      "vps",
      owner.x,
      owner.y,
    );
  });
  await evictDurableObject(stub);
  const message = (check: "signed" | "token", providers: ReadonlyArray<ProviderReport>) =>
    runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(daemonSocket(check), JSON.stringify({ type: "providers", providers })),
    );
  const card = () =>
    runInDurableObject(stub, (_, state) =>
      state.storage.sql
        .exec<{ body: string }>("SELECT body FROM resources WHERE id = ?", appId)
        .toArray()
        .map((row) => JSON.parse(row.body) as Resource)
        .at(0),
    );
  const sql = async (query: string, ...values: Array<string | number>) => {
    await runInDurableObject(stub, (_, state) => void state.storage.sql.exec(query, ...values));
    await evictDurableObject(stub);
  };
  const lastSummary = () =>
    runInDurableObject(
      stub,
      (_, state) =>
        state.storage.sql
          .exec<{ summary: string }>("SELECT summary FROM revisions ORDER BY id DESC LIMIT 1")
          .one().summary,
    );
  return { stub, message, card, sql, lastSummary };
}

it("makes cards from a signed report only, shows an offline provider, and records a removal (K-704, K-705)", async () => {
  const { stub, message, card, sql } = await setup();
  await message("token", [report([app])]);
  expect(await card()).toBeUndefined();

  await message("signed", [report([app])]);
  expect(await card()).toMatchObject({
    kind: "t3.app",
    machine: "vps",
    provider: { name: "t3", localId: "app" },
  });

  await message("signed", [report([app], false)]);
  expect((await card())?.status).toBe("offline");
  // A report that does not name the provider keeps its cards.
  await message("signed", []);
  expect(await card()).toBeDefined();

  // K-705: a dropped card keeps its place and shares for a day, offline, and comes back whole.
  await sql("INSERT OR REPLACE INTO places (id, x, y) VALUES (?, 0, 0)", appId);
  await message("signed", [report([])]);
  expect(await card()).toMatchObject({ status: "offline", provider: { droppedAt: expect.any(Number) } });
  await message("signed", [report([app])]);
  expect((await card())?.provider?.droppedAt).toBeUndefined();
  expect(
    await runInDurableObject(stub, (_, state) =>
      state.storage.sql.exec("SELECT 1 FROM places WHERE id = ?", appId).toArray(),
    ),
  ).toHaveLength(1);

  // kitshn never forgets it by itself, however long ago its provider dropped it.
  await message("signed", [report([])]);
  const dropped = await card();
  await sql(
    "UPDATE resources SET body = ? WHERE id = ?",
    JSON.stringify({ ...dropped, provider: { ...dropped!.provider, droppedAt: 0 } }),
    appId,
  );
  await message("signed", [report([])]);
  expect(await card()).toMatchObject({ provider: { droppedAt: 0 } });
});

it("stores desired state from a provider, and runs a provider command that an agent on the machine asks for (K-709, K-1612)", async () => {
  const { stub, sql, lastSummary } = await setup();
  const sent: Array<unknown> = [];
  const raw = (message: object) =>
    runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(daemonSocket("signed", sent), JSON.stringify(message)),
    );
  const stateKind = { id: "t3.settings", name: "settings", levels: {}, state: {} };
  await raw({
    type: "providers",
    providers: [{ ...report([app]), kinds: [...report([]).kinds, stateKind] }],
  });
  await raw({
    type: "desiredSet",
    provider: "t3",
    kind: "t3.settings",
    part: "shared",
    value: { theme: "dark" },
  });
  await raw({ type: "desiredSet", provider: "t3", kind: "t3.nope", part: "machine", value: 1 });
  const rows = await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec("SELECT kind, machine_id, body FROM desired_state").toArray(),
  );
  expect(rows).toEqual([{ kind: "t3.settings", machine_id: "", body: '{"theme":"dark"}' }]);
  expect(await lastSummary()).toBe("Set the shared part of t3.settings (K-709)");

  // K-1612: the machine is in an agent circle that runs commands and holds every card on the machine.
  const agents: Circle = {
    id: "agents",
    name: "Agents",
    color: "#ffcc00",
    level: "control",
    members: [{ _tag: "machine", machineId: "vps", rights: { runsCommands: { mode: "automatic" } } }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 5000,
    y: 5000,
    r: 200,
  };
  await sql("INSERT OR REPLACE INTO circles (id, body) VALUES ('agents', ?)", JSON.stringify(agents));
  await sql("INSERT OR REPLACE INTO places (id, x, y) VALUES ('vps', 5000, 5000)");
  await sql("INSERT OR REPLACE INTO places (id, x, y) VALUES (?, 5000, 5000)", appId);
  const command = { kind: "provider", provider: "t3", command: "restart", resource: appId };
  await raw({ type: "ask", requestId: "r1", ask: { action: "job", target: "vps", body: { command } } });
  expect(sent).toContainEqual(
    expect.objectContaining({ type: "askAnswer", requestId: "r1", outcome: "done" }),
  );
  const job = await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec<{ command: string }>("SELECT command FROM jobs ORDER BY id DESC LIMIT 1").one(),
  );
  expect(JSON.parse(job.command)).toMatchObject({ kind: "provider", command: "restart", resource: "app" });
  await sql("DELETE FROM circles WHERE id = 'agents'");
});

it("records the calls that a machine reports on other machines, as its own and only on a signed connection (K-1610)", async () => {
  const { stub } = await setup();
  const audit = {
    kind: "exec",
    target: "mac",
    thread: "thread-1",
    name: "git status",
    cwd: "/home/kcw",
    outcome: "succeeded",
    exitCode: 0,
    at: 0,
  };
  const raw = (check: "signed" | "token", message: object) =>
    runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(daemonSocket(check), JSON.stringify(message)),
    );
  await runInDurableObject(stub, (_, state) => void state.storage.sql.exec("DELETE FROM link_events"));
  await raw("token", { type: "audit", audit });
  await raw("signed", { type: "audit", audit: { ...audit, outcome: "maybe" } });
  await raw("signed", { type: "audit", audit });
  const rows = await runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec("SELECT source, target, kind, name, outcome, exit_code FROM link_events")
      .toArray(),
  );
  expect(rows).toEqual([
    { source: "vps", target: "mac", kind: "exec", name: "git status", outcome: "succeeded", exit_code: 0 },
  ]);
});

it("keeps an address that another card holds, or a name of kitshn, off a provider card (K-705)", async () => {
  const { message, card, sql } = await setup();
  const other: Resource = {
    id: "other",
    kind: "site.static",
    name: "other",
    addresses: ["t3-vps.example.com"],
    status: "running",
    group: null,
    machine: null,
  };
  await sql("INSERT OR REPLACE INTO resources (id, body) VALUES ('other', ?)", JSON.stringify(other));
  await message("signed", [report([{ ...app, site: { name: "t3-vps", port: 3773 } }])]);
  expect((await card())?.addresses).toEqual([]);
  await sql("DELETE FROM resources WHERE id LIKE 'p-%'");
  await message("signed", [report([{ ...app, site: { name: "pages", port: 3773 } }])]);
  expect(await card()).toBeUndefined();
});

it("queues only a command that the card's provider has (K-707)", async () => {
  stubAccessCerts();
  const { message, sql, lastSummary } = await setup();
  await sql("INSERT OR REPLACE INTO places (id, x, y) SELECT ?, x, y FROM places WHERE id = 'vps'", appId);
  await message("signed", [report([app])]);
  const token = await accessToken("admin-aud", { email: "owner@example.com" });
  const job = (command: object) =>
    send("/api/jobs", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": token, "content-type": "application/json" },
      body: JSON.stringify({ machineId: "vps", command }),
    });
  const unknown = await job({ kind: "provider", provider: "t3", command: "format", resource: appId });
  expect(unknown.status).toBe(409);
  expect(await job({ kind: "provider", provider: "t3", command: "restart", resource: appId })).toHaveProperty(
    "status",
    200,
  );
  const stored = await runInDurableObject(env.KITSHN.getByName("kitshn"), (_, state) =>
    state.storage.sql.exec<{ command: string }>("SELECT command FROM jobs ORDER BY id DESC LIMIT 1").one(),
  );
  // The daemon gets the provider's own id of the card.
  expect(JSON.parse(stored.command)).toEqual({
    kind: "provider",
    provider: "t3",
    command: "restart",
    resource: "app",
  });

  // K-1625: a row command needs a row of the card that offers it.
  expect(
    (await job({ kind: "provider", provider: "t3", command: "restart", resource: appId, row: "r9" })).status,
  ).toBe(409);

  // K-717: a card setting needs control on the card, here through the Owner circle.
  const channel = {
    id: "updateChannel",
    title: "Update channel",
    values: ["nightly", "daily"],
    default: "nightly",
  };
  const stateKind = {
    id: "t3.settings",
    name: "settings",
    levels: {},
    state: { schema: { type: "object" } },
  };
  const loose = { ...app, id: "loose", name: "Loose" };
  await message("signed", [
    { ...report([app, loose]), kinds: [{ ...report([]).kinds[0]!, settings: [channel] }, stateKind] },
  ]);
  const post = (path: string, method: string, body: object) =>
    send(path, {
      method,
      headers: { "cf-access-jwt-assertion": token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const setting = (value: string, cardId = appId) =>
    post(`/api/cards/${cardId}/settings`, "POST", { key: "updateChannel", value });
  // A card in no circle gives nobody control.
  expect((await setting("daily", providerCardId("vps", "t3", "loose"))).status).toBe(403);
  expect((await setting("weekly")).status).toBe(400);
  expect((await setting("daily")).status).toBe(200);
  expect(await lastSummary()).toBe("Set Update channel of T3 on vps to daily (K-717)");

  // K-709: the map sets the shared part and a machine part, and reads them with the schema.
  expect(
    (await post("/api/desired/t3.settings", "PUT", { machineId: null, value: { theme: "dark" } })).status,
  ).toBe(200);
  expect(
    (await post("/api/desired/t3.settings", "PUT", { machineId: "vps", value: { font: 14 } })).status,
  ).toBe(200);
  const read = await send("/api/desired/t3.settings", { headers: { "cf-access-jwt-assertion": token } });
  expect(await read.json()).toEqual({
    kind: "t3.settings",
    schema: { type: "object" },
    shared: { theme: "dark" },
    machines: { vps: { font: 14 } },
  });
  expect((await post("/api/desired/t3.nope", "PUT", { machineId: null, value: 1 })).status).toBe(404);

  // K-707: a registration without the command takes it off the card.
  await message("signed", [{ ...report([app]), commands: [] }]);
  expect((await job({ kind: "provider", provider: "t3", command: "restart", resource: appId })).status).toBe(
    409,
  );
});

it("forgets only a provider that does not run, and an offline report does not bring it back (K-704, K-705)", async () => {
  stubAccessCerts();
  const { message, card, lastSummary } = await setup();
  await message("signed", [report([app])]);
  const token = await accessToken("admin-aud", { email: "owner@example.com" });
  const forget = (card: string | null = null) =>
    send("/api/machines/vps/providers/t3/forget", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": token, "content-type": "application/json" },
      body: JSON.stringify({ card }),
    });
  expect((await forget()).status).toBe(409);
  // K-705: a card that the running provider dropped goes alone; a card it still reports does not.
  const thread = { ...app, id: "th-1", name: "Fix" };
  const threadId = providerCardId("vps", "t3", "th-1");
  await message("signed", [report([app, thread])]);
  expect((await forget(threadId)).status).toBe(409);
  await message("signed", [report([app])]);
  expect((await forget(threadId)).status).toBe(200);
  expect(await lastSummary()).toBe("Forgot 1 card of the provider t3 (K-704)");
  await message("signed", [report([app], false)]);
  expect((await forget()).status).toBe(200);
  expect(await card()).toBeUndefined();
  expect(await lastSummary()).toBe("Forgot 1 card of the provider t3 (K-704)");
  // The daemon reports the provider from providers.json until it hears of the forget; that report brings nothing back.
  await message("signed", [report([app], false)]);
  expect(await card()).toBeUndefined();
  // A provider that registers again runs, so its cards come back as new cards.
  await message("signed", [report([app])]);
  expect(await card()).toBeDefined();
});
