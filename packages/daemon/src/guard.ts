import { dirname, join, resolve } from "node:path";

/**
 * K-818: Compose keys that need no allowance, because they cannot reach past the app's own folders,
 * network and limits. Every other key, and every risky value of these keys, comes back as a setting name
 * that only an allow list entry of the owner lets through. New Compose features are refused until they
 * are on this list, so they never become a way around it.
 */
const SAFE_SERVICE_KEYS = new Set([
  "build",
  "command",
  "container_name",
  "cpus",
  "cpu_shares",
  "depends_on",
  "deploy",
  "entrypoint",
  "environment",
  "env_file",
  "expose",
  "healthcheck",
  "hostname",
  "image",
  "init",
  "labels",
  "logging",
  "mem_limit",
  "mem_reservation",
  "networks",
  "pull_policy",
  "read_only",
  "restart",
  "secrets",
  "configs",
  "shm_size",
  "stdin_open",
  "stop_grace_period",
  "stop_signal",
  "tmpfs",
  "tty",
  "ulimits",
  "user",
  "volumes",
  "working_dir",
  "platform",
]);
const SAFE_BUILD_KEYS = new Set(["context", "dockerfile", "args", "target", "labels", "cache_from", "tags", "platforms"]);
const SAFE_TOP_KEYS = new Set(["name", "services", "volumes", "networks", "secrets", "configs"]);
/** The network that KitSHn 1 apps join; every app on a machine shares it, as in KitSHn 1. */
const SHARED_NETWORK = "kitshn-edge";

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
const list = (value: unknown): Array<unknown> => (Array.isArray(value) ? value : []);

/**
 * Follows symlinks of the longest part of a path that exists, then adds the rest, so a link in the repo or
 * a folder that Docker would create cannot point out of the app's folders.
 */
export function realpathOf(path: string, realpath: (path: string) => string, exists: (path: string) => boolean): string {
  const absolute = resolve(path);
  if (exists(absolute)) return realpath(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(realpathOf(parent, realpath, exists), absolute.slice(parent.length + 1));
}

/**
 * K-818: the settings of a Compose app that need an allowance. `config` is `docker compose config --format
 * json`; `uninterpolated` is the same with `--no-interpolate`, which still names the env and label files.
 */
export function composeRisks(
  config: unknown,
  uninterpolated: unknown,
  project: string,
  /** The app's own folders: its source, data, logs and sockets, with symlinks resolved. */
  roots: ReadonlyArray<string>,
  real: (path: string) => string,
): Array<string> {
  const risks = new Set<string>();
  const inside = (path: string) => {
    const resolved = real(path);
    return roots.some((root) => resolved === root || resolved.startsWith(`${root}/`));
  };
  const top = record(config);
  for (const key of Object.keys(top)) if (!SAFE_TOP_KEYS.has(key) && !key.startsWith("x-")) risks.add(`top:${key}`);
  for (const service of Object.values(record(top["services"]))) {
    const s = record(service);
    for (const key of Object.keys(s)) if (!SAFE_SERVICE_KEYS.has(key) && !key.startsWith("x-")) risks.add(key);
    for (const volume of list(s["volumes"])) {
      const v = record(volume);
      if (v["type"] === "bind" && typeof v["source"] === "string" && !inside(v["source"]))
        risks.add(`bind:${resolve(v["source"])}`);
      else if (v["type"] !== "bind" && v["type"] !== "volume" && v["type"] !== "tmpfs") risks.add(`volume:${String(v["type"])}`);
    }
    const build = record(s["build"]);
    for (const key of Object.keys(build)) if (!SAFE_BUILD_KEYS.has(key)) risks.add(`build.${key}`);
    if (typeof build["context"] === "string" && (build["context"].includes("://") || !inside(build["context"])))
      risks.add(`build:${build["context"]}`);
    if (typeof build["dockerfile"] === "string" && build["dockerfile"].startsWith("/") && !inside(build["dockerfile"]))
      risks.add(`build:${build["dockerfile"]}`);
    for (const name of Object.keys(record(s["networks"])))
      if (name !== "default" && name !== SHARED_NETWORK && !Object.hasOwn(record(top["networks"]), name))
        risks.add(`network:${name}`);
    const deploy = record(s["deploy"]);
    for (const key of Object.keys(deploy))
      if (!["resources", "restart_policy", "replicas", "labels"].includes(key)) risks.add(`deploy.${key}`);
    if (Object.keys(record(record(deploy["resources"])["reservations"])).includes("devices")) risks.add("devices");
  }
  // The env and label files are gone from the interpolated config, so they come from the other one.
  for (const service of Object.values(record(record(uninterpolated)["services"]))) {
    const s = record(service);
    for (const key of ["env_file", "label_file"])
      for (const entry of list(s[key])) {
        const path = typeof entry === "string" ? entry : record(entry)["path"];
        if (typeof path !== "string" || path.includes("$") || !inside(path)) risks.add(`${key}:${String(path)}`);
      }
  }
  for (const [name, volume] of Object.entries(record(top["volumes"]))) {
    const v = record(volume);
    // A plain named volume of this project; anything else can reach another app's volume or the host.
    const own = typeof v["name"] !== "string" || v["name"] === `${project}_${name}`;
    if (!own || v["external"] === true || v["driver"] !== undefined || v["driver_opts"] !== undefined)
      risks.add(`volume:${name}`);
  }
  for (const [name, network] of Object.entries(record(top["networks"]))) {
    const n = record(network);
    if (name === SHARED_NETWORK || n["name"] === SHARED_NETWORK) continue;
    const own = typeof n["name"] !== "string" || n["name"] === `${project}_${name}`;
    if (!own || n["external"] === true || n["driver"] !== undefined || n["driver_opts"] !== undefined)
      risks.add(`network:${name}`);
  }
  for (const section of ["secrets", "configs"])
    for (const entry of Object.values(record(top[section]))) {
      const file = record(entry)["file"];
      if (typeof file === "string" && !inside(file)) risks.add(`file:${resolve(file)}`);
    }
  return [...risks].sort();
}

/** K-818: every bind source of a config, checked again right before `up` with nothing of the app running. */
export function bindSources(config: unknown): Array<string> {
  return Object.values(record(record(config)["services"])).flatMap((service) =>
    list(record(service)["volumes"]).flatMap((volume) => {
      const v = record(volume);
      return v["type"] === "bind" && typeof v["source"] === "string" ? [v["source"]] : [];
    }),
  );
}
