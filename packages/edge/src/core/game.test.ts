import { describe, expect, it } from "vitest";
import { type Game, HOUR_MS, busyPort, doorAddress, doorPlan, gameError, openDoors } from "./game.ts";

const game: Game = {
  card: "c1",
  machine: "vps",
  name: "mc",
  ports: [{ port: 25565, proto: "tcp" }],
  doorMs: HOUR_MS,
  srv: null,
  relay: null,
};

describe("doorAddress (K-2004)", () => {
  it.each([
    ["203.0.113.9", "203.0.113.9"],
    ["2001:DB8:1:2:aaaa::1", "2001:db8:1:2::/64"],
    ["2602:ff16:6:105c::1", "2602:ff16:6:105c::/64"],
    ["10.1.2.3", null],
    ["100.64.0.1", null],
    ["172.31.0.1", null],
    ["192.168.1.1", null],
    ["127.0.0.1", null],
    ["fe80::1", null],
    ["fd00::1", null],
    ["::1", null],
    ["256.1.1.1", null],
    ["1.2.3", null],
    ["::ffff:1.2.3.4", null],
  ])("%s opens %s", (seen, address) => {
    const door = doorAddress(seen);
    expect("error" in door ? null : door.address).toBe(address);
  });
});

describe("gameError (K-2001, K-2008)", () => {
  const ok = { name: "mc", ports: game.ports, doorMs: HOUR_MS, srv: null, relay: null };
  it.each([
    [{}, null],
    [{ name: "join" }, /keeps the name/],
    [{ ports: [] }, /1 to 4 ports/],
    [{ ports: [{ port: 80, proto: "tcp" }] }, /1024 to 65535/],
    [{ ports: [game.ports[0], game.ports[0]] }, /each port once/],
    [{ doorMs: 8 * 24 * HOUR_MS }, /1 hour to 7 days/],
    [{ srv: "Mine craft" }, /SRV service/],
    [{ srv: "minecraft", ports: [{ port: 19132, proto: "udp" }] }, /needs a TCP port/],
    [{ relay: "vps", ports: [{ port: 19132, proto: "udp" }] }, /one TCP port/],
    [{ ports: [{ port: 41641, proto: "udp" }] }, /belongs to Tailscale/],
  ])("%o gives %s", (change, error) => {
    const result = gameError({ ...ok, ...change } as typeof ok);
    if (error === null) expect(result).toBeNull();
    else expect(result).toMatch(error);
  });
});

it.each([
  [{ port: 25565, process: "java", status: null }, null],
  [{ port: 25565, process: "node", status: 200 }, 25565],
  [{ port: 25565, process: "sshd", status: null }, 25565],
  [{ port: 8080, process: "node", status: 200 }, null],
])("a running server %o makes the game port 25565/tcp busy: %s (K-2001)", (server, busy) => {
  expect(busyPort([{ port: 25565, proto: "tcp" }], [{ title: null, ...server }])?.port ?? null).toBe(busy);
});

it("a new address replaces only the older door of its family (K-2004)", () => {
  const current = [
    { card: "c1", person: "a@x", address: "203.0.113.9", openedAt: 0, endsAt: 10_000 },
    { card: "c1", person: "a@x", address: "2001:db8:1:2::/64", openedAt: 0, endsAt: 10_000 },
    { card: "c1", person: "b@x", address: "198.51.100.1", openedAt: 0, endsAt: 10_000 },
  ];
  const { open, close } = openDoors(current, game, "a@x", ["203.0.113.10"], 1000);
  expect(close).toEqual(["203.0.113.9"]);
  expect(open).toEqual([
    { card: "c1", person: "a@x", address: "203.0.113.10", openedAt: 1000, endsAt: 1000 + HOUR_MS },
  ]);
});

it("the plan of a machine merges doors per address, keeps the later end, and follows a relay (K-2005, K-2008)", () => {
  const second: Game = { ...game, card: "c2", ports: [{ port: 7777, proto: "tcp" }], relay: "relay" };
  const doors = [
    { card: "c1", person: "a@x", address: "203.0.113.9", openedAt: 0, endsAt: 5000 },
    { card: "c1", person: "b@x", address: "203.0.113.9", openedAt: 0, endsAt: 9000 },
    { card: "c1", person: "c@x", address: "198.51.100.1", openedAt: 0, endsAt: 500 },
    { card: "c2", person: "a@x", address: "203.0.113.9", openedAt: 0, endsAt: 9000 },
  ];
  expect(doorPlan("vps", [game, second], doors, 1000, "example.com")).toEqual({
    ports: [{ port: 25565, proto: "tcp" }],
    relays: [],
    doors: [{ address: "203.0.113.9", ports: [{ port: 25565, proto: "tcp" }], endsAt: 9000 }],
  });
  expect(doorPlan("relay", [game, second], doors, 1000, "example.com")).toMatchObject({
    ports: [{ port: 7777, proto: "tcp" }],
    relays: [{ hostname: "mc-relay.example.com", port: 7777 }],
  });
});
