import { describe, expect, it } from "vitest";
import { bindSources, composeRisks, realpathOf } from "./guard.ts";

const roots = ["/apps/a/src", "/apps/a/data", "/apps/a/logs", "/apps/a/sockets"];
const same = (path: string) => path;
const risks = (config: unknown, uninterpolated: unknown = {}) => composeRisks(config, uninterpolated, "a", roots, same);

describe("risky Compose settings (K-818)", () => {
  it("passes an app that stays in its own folders", () => {
    const config = {
      name: "a",
      services: {
        web: {
          build: { context: "/apps/a/src", dockerfile: "Dockerfile" },
          environment: { A: "1" },
          networks: { default: null, "kitshn-edge": null },
          volumes: [
            { type: "bind", source: "/apps/a/data/state", target: "/data" },
            { type: "volume", source: "cache", target: "/cache" },
          ],
          restart: "unless-stopped",
        },
      },
      volumes: { cache: { name: "a_cache" } },
      networks: { default: { name: "a_default" }, "kitshn-edge": { name: "kitshn-edge", external: true } },
    };
    expect(risks(config, { services: { web: { env_file: [{ path: "/apps/a/src/.env" }] } } })).toEqual([]);
  });
  it("names every setting that reaches past the app, also ones it does not know", () => {
    const config = {
      services: {
        evil: {
          privileged: true,
          cap_add: ["SYS_ADMIN"],
          pid: "host",
          provider: { type: "./evil.sh" },
          volumes_from: ["container:other"],
          post_start: [{ command: "x", privileged: true }],
          ports: ["0.0.0.0:22:22"],
          security_opt: ["seccomp=./allow.json"],
          build: { context: "/", additional_contexts: { host: "/" } },
          networks: { other_default: null },
          volumes: [{ type: "bind", source: "/var/run/docker.sock", target: "/s" }],
        },
      },
      volumes: { theirs: { external: true, name: "b_data" }, root: { driver_opts: { o: "lowerdir=/" } } },
      networks: { other_default: { external: true, name: "b_default" } },
      secrets: { token: { file: "/home/kitshn/.config/kitshn/join.json" } },
    };
    const uninterpolated = { services: { evil: { env_file: [{ path: "/apps/b/params.env" }] } } };
    expect(risks(config, uninterpolated)).toEqual([
      "bind:/var/run/docker.sock",
      "build.additional_contexts",
      "build:/",
      "cap_add",
      "env_file:/apps/b/params.env",
      "file:/home/kitshn/.config/kitshn/join.json",
      "network:other_default",
      "pid",
      "ports",
      "post_start",
      "privileged",
      "provider",
      "security_opt",
      "volume:root",
      "volume:theirs",
      "volumes_from",
    ]);
  });
  it("follows symlinks of the part of a path that exists, also when the rest does not exist yet", () => {
    const links: Record<string, string> = { "/apps/a/src/etc": "/etc" };
    const exists = (path: string) => path === "/apps/a/src/etc" || !path.startsWith("/apps/a/src/etc");
    const real = (path: string) => realpathOf(path, (p) => links[p] ?? p, exists);
    expect(real("/apps/a/src/etc/systemd/system/ssh.service.d")).toBe("/etc/systemd/system/ssh.service.d");
    const config = { services: { web: { volumes: [{ type: "bind", source: "/apps/a/src/etc/systemd", target: "/x" }] } } };
    expect(composeRisks(config, {}, "a", roots, real)).toEqual(["bind:/apps/a/src/etc/systemd"]);
    expect(bindSources(config)).toEqual(["/apps/a/src/etc/systemd"]);
  });
});
