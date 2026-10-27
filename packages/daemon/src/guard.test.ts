import { describe, expect, it } from "vitest";
import { bindSources, composeFiles, composeRisks, rawRisks, realpathOf } from "./guard.ts";

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
          networks: { default: null },
          volumes: [
            { type: "bind", source: "/apps/a/data/state", target: "/data" },
            { type: "volume", source: "cache", target: "/cache" },
          ],
          restart: "unless-stopped",
        },
      },
      volumes: { cache: { name: "a_cache" } },
      networks: { default: { name: "a_default" } },
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
      "network:b_default",
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
  it("keeps values of safe keys inside the app: names, logging, networks, build inputs", () => {
    const config = {
      services: {
        web: {
          build: { context: "/apps/a/src", dockerfile: "../../b/Dockerfile", tags: ["postgres:16"], cache_from: ["type=local,src=/"] },
          image: "busybox:1.38",
          container_name: "b-web",
          logging: { driver: "fluentd", options: { "fluentd-address": "unix:///run/x.sock" } },
          networks: { "kitshn-edge": { aliases: ["other-db"] } },
        },
        ok: { build: { context: "/apps/a/src" }, image: "a-ok", container_name: "a-ok", logging: { driver: "local", options: { "max-size": "10m" } } },
      },
      networks: { inner: { ipam: { config: [{ subnet: "169.254.0.0/16" }] } } },
      secrets: { s: { environment: "HOME" } },
    };
    expect(risks(config)).toEqual([
      "build.cache_from",
      "build.tags",
      "build:../../b/Dockerfile",
      "container_name",
      "image",
      "logging",
      "network:inner",
      "network:kitshn-edge",
      "networks.options",
      "secrets.environment",
    ]);
  });
  it("names only the app's own service as an image, container or build tag", () => {
    const named = (name: string, tag: string) => ({
      services: { web: { build: { context: "/apps/a/src", tags: [tag] }, image: name, container_name: name } },
    });
    const preview = (config: unknown) => composeRisks(config, {}, "a-pr-1", roots, same);
    expect(preview(named("a-pr-1-web", "a-pr-1-web:v2"))).toEqual([]);
    // Another app's project starts with this one's name: a-pr-12 owns a-pr-12-web.
    expect(preview(named("a-pr-12-web", "a-pr-12-web:latest"))).toEqual(["build.tags", "container_name", "image"]);
    expect(preview(named("a-pr-1-db", "a-pr-1-web:5000/x"))).toEqual(["build.tags", "container_name", "image"]);
  });
  it("needs an allowance for the shared kitshn-edge network, also under another key", () => {
    const config = {
      services: { web: { networks: { edge: null } } },
      networks: { edge: { name: "kitshn-edge", external: true } },
    };
    expect(risks(config)).toEqual(["network:kitshn-edge"]);
  });
});

describe("raw Compose files (K-818)", () => {
  it("finds include and extends in every YAML form that Compose reads", () => {
    const files = [
      "include:\n  - ../other.yml\nservices:\n  web:\n    extends:\n      file: /x.yml\n",
      '"include":\n  - ../other.yml\nservices:\n  web:\n    "extends": {file: /x.yml, service: a}\n',
      "include :\n  - ../other.yml\nservices:\n  web:\n    extends :\n      file: /x.yml\n",
      "{include: [../other.yml], services: {web: {extends: {file: /x.yml, service: a}}}}",
      '{"include": ["../other.yml"], "services": {"web": {"extends": {"file": "/x.yml", "service": "a"}}}}',
      "x-base: &base\n  extends: {file: /x.yml, service: a}\n<<: {include: [../other.yml]}\nservices:\n  web:\n    <<: *base\n",
    ];
    for (const file of files) expect(rawRisks(file)).toEqual(["include", "extends"]);
    expect(rawRisks("services:\n  web:\n    image: a-web\n")).toEqual([]);
  });
  it("refuses a file that is not one YAML mapping", () => {
    expect(() => rawRisks("services: [\n")).toThrow();
    expect(() => rawRisks("services: {}\n---\ninclude: [../other.yml]\n")).toThrow();
    expect(() => rawRisks("<<: 5\nservices: {}\n")).toThrow();
  });
});

describe("Compose files of an app (K-818)", () => {
  const source = "/apps/a/src";
  const files = (present: ReadonlyArray<string>, file: string | null = null) =>
    composeFiles(source, file, (path) => present.includes(path), same);
  it("picks the files that Compose picks on its own: one main file and its override", () => {
    expect(files(["/apps/a/src/compose.yml", "/apps/a/src/docker-compose.yml", "/apps/a/src/compose.override.yaml"])).toEqual([
      "/apps/a/src/compose.yml",
      "/apps/a/src/compose.override.yaml",
    ]);
    expect(() => files([])).toThrow();
  });
  it("takes a named file only inside the source, and only when it exists", () => {
    expect(files(["/apps/a/src/deploy/compose.yml"], "deploy/compose.yml")).toEqual(["/apps/a/src/deploy/compose.yml"]);
    expect(() => files(["/apps/a/src/deploy/compose.yml"], "compose.yml")).toThrow();
    expect(() => files(["/apps/b/src/compose.yml"], "../../b/src/compose.yml")).toThrow();
    expect(() => files(["/etc/compose.yml"], "/etc/compose.yml")).toThrow();
    const linked = (path: string) => (path === "/apps/a/src/compose.yml" ? "/apps/b/src/compose.yml" : path);
    expect(() => composeFiles(source, "compose.yml", () => true, linked)).toThrow();
  });
});
