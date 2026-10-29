import { expect, it } from "vitest";
import { helperInput, listening } from "./doors.ts";

it("gives the root helper one line per port and per open door and port, without ended doors (K-2005)", () => {
  const plan = {
    ports: [
      { port: 25565, proto: "tcp" as const },
      { port: 19132, proto: "udp" as const },
    ],
    relays: [],
    doors: [
      { address: "203.0.113.9", ports: [{ port: 25565, proto: "tcp" as const }], endsAt: 61_000 },
      { address: "2001:db8:1:2::/64", ports: [{ port: 19132, proto: "udp" as const }], endsAt: 3_000 },
      { address: "198.51.100.1", ports: [{ port: 25565, proto: "tcp" as const }], endsAt: 1_500 },
    ],
  };
  expect(helperInput(plan, 1_000).split("\n")).toEqual([
    "port tcp 25565",
    "port udp 19132",
    "open4 203.0.113.9 tcp 25565 60",
    "open6 2001:db8:1:2:: udp 19132 2",
    "",
  ]);
});

it("reads the listening ports from ss, for IPv4 and IPv6 sockets (K-2006)", () => {
  const output = [
    "tcp   LISTEN 0      4096   0.0.0.0:25565   0.0.0.0:*",
    "udp   UNCONN 0      0      [::]:19132      [::]:*",
    "tcp   LISTEN 0      4096   127.0.0.1:2019  0.0.0.0:*",
  ].join("\n");
  expect([...listening(output)].sort()).toEqual(["19132/udp", "2019/tcp", "25565/tcp"]);
});
