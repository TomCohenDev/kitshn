import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { helperInput, listening, planOf, sudoersLine, systemTool, toolProblem } from "./doors.ts";

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

it("lets the daemon user run only `apply` of the helper as root (K-2002)", () => {
  expect(sudoersLine("kitshn")).toBe("kitshn ALL=(root) NOPASSWD: /usr/local/lib/kitshn/doors apply\n");
});

it("reads a kept plan only in this daemon's shape, so an old one never stops the start (K-2005)", () => {
  const plan = { ports: [{ port: 25565, proto: "tcp" }], doors: [], relays: [] };
  expect(planOf(plan)).toEqual(plan);
  expect(planOf({ ports: [{ port: 25565, proto: "tcp" }], doors: [] })).toEqual(plan);
  expect(planOf({ ports: "25565/tcp", doors: [] })).toBeNull();
  expect(planOf({ ports: [], doors: [{ address: "203.0.113.9", endsAt: "soon", ports: [] }] })).toBeNull();
  expect(planOf(null)).toBeNull();
});

it("finds a system tool outside the PATH, and names a missing tool instead of an empty output (K-2002)", () => {
  expect(systemTool("visudo", (path) => path === "/usr/sbin/visudo")).toBe("/usr/sbin/visudo");
  expect(systemTool("visudo", () => false)).toBe("visudo");
  const missing = spawnSync("kitshn-no-such-tool", ["-cf", "x"], { encoding: "utf8" });
  expect(toolProblem("visudo", missing, "refused the sudoers line")).toBe("visudo was not found");
  const refused = spawnSync("/bin/sh", ["-c", "echo '>>> line 1: syntax error' >&2; exit 1"], {
    encoding: "utf8",
  });
  expect(toolProblem("visudo", refused, "refused the sudoers line")).toBe(
    "visudo refused the sudoers line: >>> line 1: syntax error",
  );
  expect(toolProblem("visudo", spawnSync("/bin/sh", ["-c", "exit 0"], { encoding: "utf8" }))).toBeNull();
});
