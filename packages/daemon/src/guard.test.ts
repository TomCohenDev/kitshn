import { describe, expect, it } from "vitest";
import { composeRisks } from "./guard.ts";

const roots = ["/apps/a/src", "/apps/a/data", "/apps/a/logs", "/apps/a/sockets"];
const same = (path: string) => path;

describe("risky Compose settings (K-818)", () => {
  it("passes an app that stays in its own folders", () => {
    const config = {
      services: {
        web: {
          build: { context: "/apps/a/src" },
          volumes: [
            { type: "bind", source: "/apps/a/data/state", target: "/data" },
            { type: "bind", source: "/apps/a/sockets", target: "/sockets" },
            { type: "volume", source: "cache", target: "/cache" },
          ],
        },
      },
      volumes: { cache: {} },
    };
    expect(composeRisks(config, roots, same)).toEqual([]);
  });
  it("names every way to root, the machine's files or another namespace", () => {
    const config = {
      services: {
        evil: {
          privileged: true,
          cap_add: ["SYS_ADMIN"],
          devices: [{ source: "/dev/sda", target: "/dev/sda" }],
          pid: "host",
          network_mode: "host",
          ipc: "container:other",
          security_opt: ["seccomp:unconfined"],
          build: { context: "/" },
          volumes: [
            { type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" },
            { type: "bind", source: "/apps/a/data/../../b/data", target: "/b" },
          ],
        },
      },
      secrets: { token: { file: "/home/kitshn/.config/kitshn/join.json" } },
      volumes: { root: { driver_opts: { type: "none", o: "bind", device: "/etc" } } },
    };
    expect(composeRisks(config, roots, same)).toEqual([
      "bind:/apps/b/data",
      "bind:/etc",
      "bind:/var/run/docker.sock",
      "build:/",
      "cap_add:SYS_ADMIN",
      "devices",
      "file:/home/kitshn/.config/kitshn/join.json",
      "ipc:container",
      "network_mode:host",
      "pid:host",
      "privileged",
      "security_opt:seccomp:unconfined",
    ]);
  });
  it("follows a symlink in the repo that points out of the app's folders", () => {
    const config = { services: { web: { volumes: [{ type: "bind", source: "/apps/a/src/link", target: "/x" }] } } };
    const realpath = (path: string) => (path === "/apps/a/src/link" ? "/root" : path);
    expect(composeRisks(config, roots, realpath)).toEqual(["bind:/apps/a/src/link"]);
  });
});
