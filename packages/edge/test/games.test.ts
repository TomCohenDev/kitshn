import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { DoorPlan } from "../src/core/game.ts";
import type { Machine } from "../src/core/machine.ts";
import type { Circle, Resource } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

/** Section 20: a door opens for a person of the card's circles, and closes when the person leaves the circle. */

const friends: Circle = {
  id: "friends",
  name: "Friends",
  color: "#22c55e",
  level: "view",
  members: [{ _tag: "email", email: "friend@example.com" }],
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x: 9000,
  y: 9000,
  r: 300,
};

async function setup() {
  const machine: Machine = {
    id: "vps",
    name: "vps",
    labels: [],
    order: 0,
    serviceTokenId: "token-vps",
    clientId: "vps.access",
    tunnelId: "tunnel-vps",
  };
  const card: Resource = {
    id: "game1",
    kind: "game",
    name: "mc",
    addresses: ["mc.example.com"],
    status: "unknown",
    group: null,
    machine: "vps",
  };
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (_, state) => {
    const sql = state.storage.sql;
    sql.exec("INSERT OR REPLACE INTO machines (id, body) VALUES ('vps', ?)", JSON.stringify(machine));
    sql.exec("INSERT OR REPLACE INTO circles (id, body) VALUES ('friends', ?)", JSON.stringify(friends));
    sql.exec("INSERT OR REPLACE INTO resources (id, body) VALUES ('game1', ?)", JSON.stringify(card));
    sql.exec("INSERT OR REPLACE INTO places (id, x, y) VALUES ('game1', 9000, 9000)");
    sql.exec(
      `INSERT OR REPLACE INTO games (card_id, machine_id, name, ports, door_ms, srv, relay_id, v4, v6)
       VALUES ('game1', 'vps', 'mc', '[{"port":25565,"proto":"tcp"}]', 3600000, 'minecraft', NULL, '198.51.100.7', NULL)`,
    );
    sql.exec("DELETE FROM doors");
    sql.exec("DELETE FROM jobs");
  });
  await evictDurableObject(stub);
  return stub;
}

const visitor = (email: string | null, ip: string) => ({
  email,
  clientId: null,
  ip,
  passkey: false,
  issuedAt: null,
});

async function game(stub: DurableObjectStub, body: unknown) {
  const answer = await stub.fetch("https://kitshn.internal/internal/game", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return (await answer.json()) as {
    decision: string;
    error: string | null;
    doors: Array<{ address: string }>;
  };
}

const doorJobs = (stub: DurableObjectStub) =>
  runInDurableObject(stub, (_, state) =>
    state.storage.sql
      .exec<{ command: string; state: string }>(
        "SELECT command, state FROM jobs WHERE json_extract(command, '$.kind') = 'doors' ORDER BY id",
      )
      .toArray()
      .map((row) => ({ state: row.state, plan: (JSON.parse(row.command) as { plan: DoorPlan }).plan })),
  );

it("opens one door per family for a person of the card, and closes it when the person leaves (K-2004, K-2005)", async () => {
  stubAccessCerts();
  const stub = await setup();
  // A door belongs to a person, so no login means the login step.
  expect(
    (await game(stub, { name: "mc", action: "view", visitor: visitor(null, "203.0.113.9") })).decision,
  ).toBe("login");
  expect(
    (
      await game(stub, {
        name: "mc",
        action: "view",
        visitor: visitor("stranger@example.com", "203.0.113.9"),
      })
    ).decision,
  ).toBe("deny");

  // A private address never opens a door.
  const refused = await game(stub, {
    name: "mc",
    action: "open",
    visitor: visitor("friend@example.com", "10.1.2.3"),
    addresses: [],
  });
  expect(refused.error).toMatch(/private/);

  // The seen IPv4 address wins its family; the browser adds the IPv6 one, which opens its /64.
  const opened = await game(stub, {
    name: "mc",
    action: "open",
    visitor: visitor("friend@example.com", "203.0.113.9"),
    addresses: ["203.0.113.50", "2001:db8:1:2:aaaa::1"],
  });
  expect(opened.error).toBeNull();
  expect(opened.doors.map((door) => door.address).sort()).toEqual(["2001:db8:1:2::/64", "203.0.113.9"]);
  const [first] = await doorJobs(stub);
  expect(first?.plan.ports).toEqual([{ port: 25565, proto: "tcp" }]);
  expect(first?.plan.doors.map((door) => door.address).sort()).toEqual(["2001:db8:1:2::/64", "203.0.113.9"]);

  // The owner takes the friend out of the circle: the doors close at once, with a new plan.
  const edited = await send("/api/apply", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }),
      "content-type": "application/json",
    },
    body: JSON.stringify({ edits: [{ _tag: "circle", id: "friends", after: { ...friends, members: [] } }] }),
  });
  expect(edited.status, await edited.clone().text()).toBe(200);
  const jobs = await doorJobs(stub);
  expect(jobs.at(-1)?.plan.doors).toEqual([]);
  expect(jobs.at(-1)?.plan.ports).toEqual([{ port: 25565, proto: "tcp" }]);
  expect(jobs.slice(0, -1).every((job) => job.state === "failed")).toBe(true);
  const left = await runInDurableObject(stub, (_, state) =>
    state.storage.sql.exec("SELECT * FROM doors").toArray(),
  );
  expect(left).toEqual([]);
});

it("keeps a door when its circle checks the address, and refuses a second open within 10 s (K-2004, K-2005)", async () => {
  stubAccessCerts();
  const stub = await setup();
  const office: Circle = {
    ...friends,
    match: "all",
    members: [
      { _tag: "email", email: "friend@example.com" },
      { _tag: "ip", range: "203.0.113.0/24" },
    ],
  };
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec("UPDATE circles SET body = ? WHERE id = 'friends'", JSON.stringify(office));
  });
  await evictDurableObject(stub);
  const opened = await game(stub, {
    name: "mc",
    action: "open",
    visitor: visitor("friend@example.com", "203.0.113.9"),
  });
  expect(opened.error).toBeNull();
  // Any commit runs the share check of the open doors; it uses the address that opened the door.
  const edited = await send("/api/apply", {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }),
      "content-type": "application/json",
    },
    body: JSON.stringify({ edits: [{ _tag: "circle", id: "friends", after: { ...office, x: 9001 } }] }),
  });
  expect(edited.status, await edited.clone().text()).toBe(200);
  const again = await game(stub, {
    name: "mc",
    action: "open",
    visitor: visitor("friend@example.com", "203.0.113.9"),
  });
  expect(again.doors.map((door) => door.address)).toEqual(["203.0.113.9"]);
  expect(again.error).toMatch(/Wait a moment/);
});

it("counts End now as a door change, so open and close in a loop wait 10 s (K-2004)", async () => {
  stubAccessCerts();
  const stub = await setup();
  const friend = visitor("friend@example.com", "203.0.113.9");
  expect((await game(stub, { name: "mc", action: "open", visitor: friend })).error).toBeNull();
  const closed = await game(stub, { name: "mc", action: "close", visitor: friend, address: "203.0.113.9" });
  expect(closed.error).toMatch(/Wait a moment/);
  expect(closed.doors.map((door) => door.address)).toEqual(["203.0.113.9"]);
});

it("removes the game cards, doors and wanted records of a removed machine (K-2001, K-2007)", async () => {
  stubAccessCerts();
  const stub = await setup();
  await game(stub, { name: "mc", action: "open", visitor: visitor("friend@example.com", "203.0.113.9") });
  const left = await runInDurableObject(stub, async (instance) => {
    const kitshn = instance as unknown as {
      api: () => unknown;
      removeMachine: (caller: unknown, id: string) => Promise<Response>;
      sql: (query: string) => Array<unknown>;
      state: { resources: Map<string, unknown> };
    };
    // The Cloudflare side of a removal is not what this test checks.
    kitshn.api = () => async () => ({});
    const caller = {
      actor: { _tag: "person", email: "owner@example.com" },
      visitor: { email: "owner@example.com", clientId: null, ip: null },
    };
    const removed = await kitshn.removeMachine(caller, "vps");
    return {
      status: removed.status,
      games: kitshn.sql("SELECT * FROM games").length,
      doors: kitshn.sql("SELECT * FROM doors").length,
      card: kitshn.state.resources.has("game1"),
    };
  });
  expect(left).toEqual({ status: 200, games: 0, doors: 0, card: false });
});

it("makes the A and SRV records of a game in one run (K-2007)", async () => {
  const stub = await setup();
  const result = await runInDurableObject(stub, async (instance) => {
    const kitshn = instance as unknown as {
      syncGameDns: (api: unknown, budget: number) => Promise<number>;
      sql: (query: string) => Array<{ type: string; error: string | null }>;
    };
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const api = async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return method === "GET" ? [] : { id: `record-${calls.length}` };
    };
    const spent = await kitshn.syncGameDns(api, 4);
    return { spent, calls, rows: kitshn.sql("SELECT type, error FROM game_records ORDER BY type") };
  });
  expect(result.spent).toBe(4);
  expect(result.rows).toEqual([
    { type: "A", error: null },
    { type: "SRV", error: null },
  ]);
  expect(
    result.calls.find((call) => call.method === "POST" && call.path.includes("dns_records")),
  ).toBeDefined();
  expect(result.calls.at(-1)?.body).toMatchObject({
    type: "SRV",
    name: "_minecraft._tcp.mc.example.com",
    data: { port: 25565, target: "mc.example.com" },
  });
});
