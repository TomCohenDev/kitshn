import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ProviderReport } from "@kitshn/local";
import { afterEach, expect, it, vi } from "vitest";
import type { Machine, MachineStatus } from "../src/core/machine.ts";
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
    state.storage.sql.exec("DELETE FROM live_sites WHERE id LIKE 'p-%'");
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
  /** The daemon reports the provider site `name`, as it does before it reports the provider's cards. */
  const sites = (name: string) =>
    runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(
        daemonSocket("signed"),
        JSON.stringify({
          type: "sites",
          sites: [{ name, target: "http://localhost:3773", dev: false, up: true }],
        }),
      ),
    );
  /** The address check finds a record of something else on the address, or none. */
  const check = (usedElsewhere: boolean) =>
    runInDurableObject(stub, async (instance) => {
      await (
        instance as unknown as {
          checkSites(
            api: (method: string, path: string) => Promise<unknown>,
            budget: number,
          ): Promise<number>;
        }
      ).checkSites(
        async (_, path) => (usedElsewhere && path.includes("dns_records") ? [{ id: "portal" }] : []),
        6,
      );
    });
  const site = async (name: string, usedElsewhere: boolean) => {
    await sites(name);
    await check(usedElsewhere);
  };
  return { stub, message, card, sql, lastSummary, site, sites, check };
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
    requestId: "d1",
    provider: "t3",
    kind: "t3.settings",
    part: "shared",
    value: { theme: "dark" },
  });
  await raw({
    type: "desiredSet",
    requestId: "d2",
    provider: "t3",
    kind: "t3.nope",
    part: "machine",
    value: 1,
  });
  // The provider gets kitshn's own answer: stored, or why not.
  const answers = (sent as Array<{ type: string; requestId?: string; error?: string | null }>).filter(
    (item) => item.type === "requestAnswer",
  );
  expect(answers).toEqual([
    { type: "requestAnswer", requestId: "d1", error: null },
    { type: "requestAnswer", requestId: "d2", error: expect.stringMatching(/no desired state/) },
  ]);
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

it("counts the pushes that a machine has not applied, and takes applied only for its own keys (K-1608)", async () => {
  const { stub, message, sql } = await setup();
  type Internals = { queuedFor(machine: Machine, status: MachineStatus | null): number | null };
  const keyed: Machine = { ...machine, key: { kind: "public", publicKey: "k", fingerprint: "f", since: 0 } };
  await sql("INSERT OR REPLACE INTO machines (id, body) VALUES ('vps', ?)", JSON.stringify(keyed));
  await message("signed", [report([app])]);
  await sql("DELETE FROM applied_state");
  const status = (capabilities: Array<string>): MachineStatus => ({
    version: "dev",
    os: "linux",
    arch: "x64",
    hostname: "vps",
    tunnel: "running",
    capabilities,
  });
  const queued = (on: Machine, live: MachineStatus | null) =>
    runInDurableObject(stub, (instance) => (instance as unknown as Internals).queuedFor(on, live));
  // A machine without a key gets no pushes, so nothing waits for it.
  expect(await queued(machine, null)).toBe(0);
  // An online daemon that does not name "applied" has an unknown count.
  expect(await queued(keyed, status([]))).toBeNull();
  const raw = (body: object) =>
    runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(daemonSocket("signed"), JSON.stringify(body)),
    );
  await raw({ type: "applied", key: "made:up", hash: "x" });
  await raw({ type: "applied", key: "grants:t3", hash: "stale" });
  const keys = await runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<{ key: string }>("SELECT key FROM applied_state")
      .toArray()
      .map((row) => row.key),
  );
  expect(keys).toEqual(["grants:t3"]);
  // Three pushes wait: the grant tables, with a stale hash, and the reach and the card settings, with none.
  expect(await queued(keyed, null)).toBe(3);
  expect(await queued(keyed, status(["applied"]))).toBe(3);
  await sql("INSERT OR REPLACE INTO machines (id, body) VALUES ('vps', ?)", JSON.stringify(machine));
});

it("holds a job that waits for an idle machine while a provider is busy, and the next report sends it (K-1608)", async () => {
  const { stub, message } = await setup();
  await message("signed", [report([app])]);
  // A real socket of the machine, so the Durable Object sends jobs to it.
  await runInDurableObject(stub, (_, state) => {
    const pair = new WebSocketPair();
    state.acceptWebSocket(pair[1], ["vps", "machines"]);
    pair[0].accept();
    pair[1].serializeAttachment({
      kind: "machine",
      machineId: "vps",
      since: Date.now(),
      challenge: "",
      check: "signed",
      answered: true,
      rotateBy: null,
      status: null,
      sample: null,
    });
  });
  const busy = (value: string) =>
    runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(
        daemonSocket("signed"),
        JSON.stringify({
          type: "providers",
          providers: [report([{ ...app, facts: [{ label: "busy", value, role: "busy" }] }])],
        }),
      ),
    );
  await busy("true");
  const id = await runInDurableObject(
    stub,
    (_, state) =>
      state.storage.sql
        .exec<{ id: number }>(
          `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, exit_code, output, when_idle)
         VALUES ('vps', '[]', '{"kind":"diagnostics"}', 'queued', 0, 9999999999999, '{"_tag":"kitshn","reason":"test"}',
         '{"kitshn":true,"email":null,"clientId":null,"ip":null}', NULL, '', 1) RETURNING id`,
        )
        .one().id,
  );
  const jobState = () =>
    runInDurableObject(
      stub,
      (_, state) =>
        state.storage.sql.exec<{ state: string }>("SELECT state FROM jobs WHERE id = ?", id).one().state,
    );
  // A report while the card is busy delivers jobs, and this one stays.
  await busy("true");
  expect(await jobState()).toBe("queued");
  await busy("false");
  expect(await jobState()).toBe("sent");
  // An open socket keeps the Durable Object busy, and the next test evicts it.
  await runInDurableObject(stub, (_, state) => {
    for (const socket of state.getWebSockets("vps")) socket.close(1000, "test over");
  });
});

it("records only the calls that a machine reports on machines that it reaches, as its own and only on a signed connection (K-1610)", async () => {
  const { stub, message, sql } = await setup();
  await message("signed", [report([app])]);
  // vps reaches the T3 card of mac: the card sits in a circle that holds the machine vps.
  const mac: Machine = { ...machine, id: "mac", name: "mac", clientId: "mac.access" };
  const macCard: Resource = {
    id: "p-mac-app",
    kind: "t3.app",
    name: "T3 on mac",
    addresses: [],
    status: "running",
    group: null,
    machine: "mac",
    provider: {
      name: "t3",
      localId: "app",
      kindName: "T3 app",
      levels: { view: "view", use: "use", control: "control" },
      facts: [],
      stickers: [],
      lists: [],
      settings: [],
      site: null,
    },
  };
  const links: Circle = {
    id: "links",
    name: "Links",
    color: "#7CFF8A",
    level: "use",
    members: [{ _tag: "machine", machineId: "vps" }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 7000,
    y: 7000,
    r: 200,
  };
  await sql("INSERT OR REPLACE INTO machines (id, body) VALUES ('mac', ?)", JSON.stringify(mac));
  await sql("INSERT OR REPLACE INTO resources (id, body) VALUES (?, ?)", macCard.id, JSON.stringify(macCard));
  await sql("INSERT OR REPLACE INTO circles (id, body) VALUES ('links', ?)", JSON.stringify(links));
  await sql("INSERT OR REPLACE INTO places (id, x, y) VALUES (?, 7000, 7000)", macCard.id);
  await sql("DELETE FROM link_events");
  const audit = {
    kind: "exec",
    target: "mac",
    thread: "thread-1",
    name: "git",
    cwd: "/home/kcw",
    outcome: "succeeded",
    exitCode: 0,
    at: 0,
  };
  const raw = (check: "signed" | "token", body: object) =>
    runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(daemonSocket(check), JSON.stringify(body)),
    );
  await raw("token", { type: "audit", audit });
  await raw("signed", { type: "audit", audit: { ...audit, outcome: "maybe" } });
  // A machine that vps does not reach, and a command line instead of a command name.
  await raw("signed", { type: "audit", audit: { ...audit, target: "other" } });
  await raw("signed", { type: "audit", audit: { ...audit, name: "curl -H secret" } });
  await raw("signed", { type: "audit", audit });
  const rows = await runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec("SELECT source, target, kind, name, outcome, exit_code FROM link_events")
      .toArray(),
  );
  expect(rows).toEqual([
    { source: "vps", target: "mac", kind: "exec", name: "git", outcome: "succeeded", exit_code: 0 },
  ]);
  await sql("DELETE FROM circles WHERE id = 'links'");
  await sql("DELETE FROM resources WHERE id = 'p-mac-app'");
});

it("keeps an address that another card holds, or a name of kitshn, off a provider card (K-705)", async () => {
  const { stub, message, card, sql, sites, check } = await setup();
  const withSite = report([{ ...app, site: { name: "t3-vps", port: 3773 } }]);
  // Whether an Access application covers the host, with or without a path.
  const covered = () =>
    runInDurableObject(stub, (instance) =>
      [
        ...(
          instance as unknown as { desired(now: number): { apps: ReadonlyMap<string, { domain: string }> } }
        )
          .desired(Date.now())
          .apps.values(),
      ].some((app) => app.domain.split("/")[0] === "t3-vps.example.com"),
    );
  // In the Owner circle, so a card with an address gets an Access application.
  await sql("INSERT OR REPLACE INTO places (id, x, y) SELECT ?, x, y FROM places WHERE id = 'vps'", appId);
  const ownCard = () =>
    runInDurableObject(
      stub,
      (_, state) =>
        state.storage.sql.exec("SELECT id FROM resources WHERE id = 'live-vps-t3-vps'").toArray().length,
    );
  // K-1623: the address waits for its check, and a host that something else serves stays off with no application.
  // The daemon sends its sites before its providers; the check runs on the alarm, before or after them.
  const orders = {
    "providers, sites, check": [() => message("signed", [withSite]), () => sites("t3-vps"), "check"],
    "sites, check, providers": [() => sites("t3-vps"), "check", () => message("signed", [withSite])],
    "sites, providers, check": [() => sites("t3-vps"), () => message("signed", [withSite]), "check"],
  } as const;
  for (const [order, steps] of Object.entries(orders)) {
    for (const usedElsewhere of [true, false]) {
      await sql("DELETE FROM live_sites WHERE machine_id = 'vps'");
      await sql("DELETE FROM resources WHERE id LIKE 'p-%' OR id LIKE 'live-%'");
      for (const step of steps) await (step === "check" ? check(usedElsewhere) : step());
      const seen = {
        card: await card(),
        ownCard: await ownCard(),
        covered: await covered(),
      };
      expect(seen, `${order}, ${usedElsewhere ? "in use" : "free"}`).toMatchObject(
        usedElsewhere
          ? {
              card: { addresses: [], provider: { stickers: [{ text: "address in use" }] } },
              ownCard: 0,
              covered: false,
            }
          : {
              card: { addresses: ["t3-vps.example.com"], provider: { stickers: [] } },
              ownCard: 0,
              covered: true,
            },
      );
    }
  }
  await sql("DELETE FROM live_sites WHERE id LIKE 'p-%'");
  await sql("DELETE FROM resources WHERE id LIKE 'p-%'");
  await sql("DELETE FROM places WHERE id LIKE 'p-%'");
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
  const { message, card, sql, lastSummary } = await setup();
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
  await sql(
    "INSERT OR REPLACE INTO card_settings (card_id, key, value) VALUES (?, 'updateChannel', 'daily')",
    threadId,
  );
  expect((await forget(threadId)).status).toBe(409);
  await message("signed", [report([app])]);
  expect((await forget(threadId)).status).toBe(200);
  // K-717: the maps get no settings of a forgotten card; the row stays for Undo.
  const snapshot = (await (
    await send("/api/state", { headers: { "cf-access-jwt-assertion": token } })
  ).json()) as { cardSettings: Record<string, unknown> };
  expect(snapshot.cardSettings[threadId]).toBeUndefined();
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

it("lists for a device the provider cards with an address that its token opens, in the portal's shape (K-1601)", async () => {
  stubAccessCerts();
  const { message, sql, site } = await setup();
  const phone: Circle = {
    id: "phone",
    name: "Phone",
    color: "#00B3FF",
    level: "use",
    members: [{ _tag: "device", tokenId: "t-phone", clientId: "phone.access", name: "Yarden's phone" }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 9000,
    y: 9000,
    r: 200,
  };
  await sql("INSERT OR REPLACE INTO circles (id, body) VALUES ('phone', ?)", JSON.stringify(phone));
  await message("signed", [
    report([
      { ...app, site: { name: "t3-vps", port: 3773 } },
      { ...app, id: "hidden", name: "Hidden" },
    ]),
  ]);
  await site("t3-vps", false);
  await sql("INSERT OR REPLACE INTO places (id, x, y) VALUES (?, 9000, 9000)", appId);
  const list = async (clientId: string) =>
    (await (
      await send("/device/machines", {
        headers: { "cf-access-jwt-assertion": await accessToken("device-aud", { common_name: clientId }) },
      })
    ).json()) as { machines: Array<unknown> };
  expect(await list("phone.access")).toEqual({
    machines: [
      {
        id: "vps",
        name: "vps",
        origin: "https://t3-vps.example.com",
        card: appId,
        kind: "t3.app",
        level: "use",
      },
    ],
  });
  // A token that no circle holds gets an empty list.
  expect(await list("stranger.access")).toEqual({ machines: [] });
  // A person's login is not a device.
  const person = await send("/device/machines", {
    headers: { "cf-access-jwt-assertion": await accessToken("device-aud", { email: "owner@example.com" }) },
  });
  expect(person.status).toBe(403);
  await sql("DELETE FROM circles WHERE id = 'phone'");
});

it("clears an Owner share setting when its card gains owner control, so later changes still commit (K-719)", async () => {
  stubAccessCerts();
  const { message, sql } = await setup();
  await message("signed", [report([app])]);
  // Before owner control, the owner lowered the Owner share of this card; that was legal then.
  await sql(
    "INSERT OR REPLACE INTO share_settings (id, body) VALUES (?, ?)",
    `${appId}/${OWNER_CIRCLE_ID}`,
    JSON.stringify({ level: "view", endsAt: 1 }),
  );
  await message("signed", [{ ...report([app]), kinds: [{ ...report([]).kinds[0]!, ownerControl: true }] }]);
  const left = await runInDurableObject(env.KITSHN.getByName("kitshn"), (_, state) =>
    state.storage.sql
      .exec("SELECT id FROM share_settings WHERE id = ?", `${appId}/${OWNER_CIRCLE_ID}`)
      .toArray(),
  );
  expect(left).toEqual([]);
  const token = await accessToken("admin-aud", { email: "owner@example.com" });
  const moved = await send("/api/apply", {
    method: "POST",
    headers: { "cf-access-jwt-assertion": token, "content-type": "application/json" },
    body: JSON.stringify({ edits: [{ _tag: "place", id: appId, after: { x: 9100, y: 9100 } }] }),
  });
  expect(moved.status).toBe(200);
});

it("lets a machine cancel only the queued jobs that it queued itself (K-1612)", async () => {
  const { stub } = await setup();
  const sent: Array<{ type: string; error?: string | null }> = [];
  const raw = (message: object) =>
    runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(daemonSocket("signed", sent as Array<unknown>), JSON.stringify(message)),
    );
  const ids = await runInDurableObject(stub, (_, state) => {
    const byVps = JSON.stringify({ _tag: "machine", machineId: "vps", name: "vps" });
    const byOwner = JSON.stringify({ _tag: "person", email: "owner@example.com" });
    const insert = (machine: string, jobState: string, actor: string) =>
      state.storage.sql
        .exec<{ id: number }>(
          `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, exit_code, output)
           VALUES (?, '[]', '{"kind":"restart"}', ?, 0, 9999999999999, ?, '{}', NULL, '') RETURNING id`,
          machine,
          jobState,
          actor,
        )
        .one().id;
    return {
      // The owner queued it for vps: a local user of vps cannot cancel it.
      ownerQueued: insert("vps", "queued", byOwner),
      sentAlready: insert("mac", "sent", byVps),
      own: insert("mac", "queued", byVps),
    };
  });
  await raw({ type: "cancelJob", requestId: "a", jobId: ids.ownerQueued });
  await raw({ type: "cancelJob", requestId: "b", jobId: ids.sentAlready });
  await raw({ type: "cancelJob", requestId: "c", jobId: ids.own });
  const answers = sent.filter((item) => item.type === "requestAnswer").map((item) => item.error === null);
  expect(answers).toEqual([false, false, true]);
  const state = await runInDurableObject(stub, (_, storage) =>
    storage.storage.sql
      .exec<{ state: string; output: string }>("SELECT state, output FROM jobs WHERE id = ?", ids.own)
      .one(),
  );
  expect(state).toEqual({ state: "failed", output: "Cancelled by vps." });
});

it("takes over a provider site's address with its application first, then ingress, then the kept record, and gives it back (K-1623)", async () => {
  const { stub, message, card, sql, site } = await setup();
  await sql("INSERT OR REPLACE INTO places (id, x, y) SELECT ?, x, y FROM places WHERE id = 'vps'", appId);
  await message("signed", [report([{ ...app, site: { name: "t3-vps", port: 3773 } }])]);
  await site("t3-vps", true);
  const calls: Array<string> = [];
  const api = async (method: string, path: string, body?: unknown) => {
    const content = isRecordLike(body) && typeof body["content"] === "string" ? ` ${body["content"]}` : "";
    const ingress =
      path.includes("cfd_tunnel") && JSON.stringify(body).includes("t3-vps.example.com")
        ? " with the host"
        : "";
    calls.push(`${method} ${path.split("?")[0]}${content}${ingress}`);
    if (method === "GET" && path.includes("/dns_records?name="))
      return [
        {
          id: "portal-record",
          type: "CNAME",
          content: "portal.cfargotunnel.com",
          proxied: true,
          comment: "T3",
        },
      ];
    if (method === "GET") return [];
    return { id: "portal-record" };
  };
  const person = (email: string) => ({
    visitor: { kitshn: false, email, clientId: null, ip: null },
    actor: { _tag: "person" as const, email },
  });
  type Internals = {
    takeAddress(caller: unknown, id: string, api: unknown): Promise<Response>;
    giveAddressBack(caller: unknown, id: string, api: unknown): Promise<Response>;
    syncTunnels(api: unknown, budget: number): Promise<void>;
    syncDns(api: unknown, budget: number): Promise<void>;
    handoverOf(id: string): { ingressAt: number | null; switched: boolean } | null;
    setHandover(id: string, value: unknown): void;
    desired(now: number): { apps: ReadonlyMap<string, { domain: string }> };
  };
  const run = <T>(fn: (instance: Internals) => T) =>
    runInDurableObject(stub, async (instance) => await fn(instance as unknown as Internals));
  const state = () =>
    runInDurableObject(stub, (_, storage) => ({
      site: storage.storage.sql
        .exec<{ state: string }>("SELECT state FROM live_sites WHERE id = ?", appId)
        .one().state,
      records: storage.storage.sql
        .exec<{ record_id: string }>("SELECT record_id FROM dns_objects WHERE address = 't3-vps.example.com'")
        .toArray()
        .map((row) => row.record_id),
    }));

  expect(
    await statusOf(run((instance) => instance.takeAddress(person("someone@example.com"), appId, api))),
  ).toBe(403);
  expect(
    await statusOf(run((instance) => instance.takeAddress(person("owner@example.com"), appId, api))),
  ).toBe(200);
  expect(await card()).toMatchObject({ addresses: ["t3-vps.example.com"], provider: { stickers: [] } });
  // The application covers `<host>/*`, which Cloudflare takes next to the application that holds the host now.
  expect(
    await run((instance) => [...instance.desired(Date.now()).apps.values()].map((item) => item.domain)),
  ).toContain("t3-vps.example.com/*");

  // No ingress before the application exists, and no record before an earlier run gave the tunnel its ingress.
  await run((instance) => instance.syncTunnels(api, 6));
  expect(calls.some((call) => call.endsWith("with the host"))).toBe(false);
  expect(await run((instance) => instance.handoverOf(appId)?.ingressAt)).toBeNull();
  await sql(
    "INSERT OR REPLACE INTO access_objects (key, cf_id, aud, body, tried, error) VALUES (?, 'cf-app', 'aud', '{}', '', NULL)",
    `app:${appId}:t3-vps.example.com`,
  );
  await run((instance) => instance.syncTunnels(api, 6));
  expect(calls.at(-1)?.endsWith("/cfd_tunnel/tunnel-vps/configurations with the host")).toBe(true);
  expect(await run((instance) => instance.handoverOf(appId)?.ingressAt)).not.toBeNull();
  // The zone's records path, as kitshn asked for the record of the address.
  const records = calls
    .find((call) => call.startsWith("GET") && call.includes("/dns_records"))!
    .slice("GET ".length);
  await run((instance) => instance.syncDns(api, 5));
  expect(calls.some((call) => call.includes("dns_records/"))).toBe(false);
  await run((instance) =>
    instance.setHandover(appId, { ...instance.handoverOf(appId), ingressAt: Date.now() - 61_000 }),
  );
  await run((instance) => instance.syncDns(api, 5));
  // The kept record changes in place; kitshn makes no second one and deletes none.
  expect(calls.filter((call) => call.includes("dns_records") && !call.startsWith("GET"))).toEqual([
    `PUT ${records}/portal-record tunnel-vps.cfargotunnel.com`,
  ]);
  expect(await state()).toEqual({ site: "ok", records: ["portal-record"] });
  expect(await run((instance) => instance.handoverOf(appId)?.switched)).toBe(true);

  // Giving it back points the record at what served it, forgets the record, and takes the address off the card.
  calls.length = 0;
  expect(
    await statusOf(run((instance) => instance.giveAddressBack(person("owner@example.com"), appId, api))),
  ).toBe(200);
  expect(calls).toEqual([`PUT ${records}/portal-record portal.cfargotunnel.com`]);
  expect(await state()).toEqual({ site: "refused", records: [] });
  expect(await card()).toMatchObject({ addresses: [], provider: { stickers: [{ text: "address in use" }] } });
  await sql("DELETE FROM access_objects WHERE key LIKE 'app:p-%'");
  await sql("DELETE FROM places WHERE id LIKE 'p-%'");
});

/** A Response from the Durable Object, read whole, so a later eviction does not wait for its body. */
const statusOf = async (answer: Promise<unknown>) => {
  const response = await answer;
  if (!(response instanceof Response)) throw new Error("The Durable Object gave no Response.");
  await response.text();
  return response.status;
};

const isRecordLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
