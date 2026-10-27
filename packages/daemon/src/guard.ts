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
    const own = (name: unknown) => typeof name === "string" && name.startsWith(`${project}-`);
    // A built image or a container name of another app would take its place on this machine.
    if (s["build"] !== undefined && s["image"] !== undefined && !own(s["image"])) risks.add("image");
    if (s["container_name"] !== undefined && !own(s["container_name"])) risks.add("container_name");
    const logging = record(s["logging"]);
    if (logging["driver"] !== undefined && logging["driver"] !== "json-file" && logging["driver"] !== "local")
      risks.add("logging");
    for (const option of Object.keys(record(logging["options"])))
      if (!["max-size", "max-file", "compress"].includes(option)) risks.add("logging");
    for (const value of Object.values(record(s["networks"])))
      if (value !== null && Object.keys(record(value)).length > 0) risks.add("networks.options");
    for (const volume of list(s["volumes"])) {
      const v = record(volume);
      if (v["type"] === "bind" && typeof v["source"] === "string" && !inside(v["source"]))
        risks.add(`bind:${resolve(v["source"])}`);
      else if (v["type"] !== "bind" && v["type"] !== "volume" && v["type"] !== "tmpfs") risks.add(`volume:${String(v["type"])}`);
    }
    const build = record(s["build"]);
    for (const key of Object.keys(build)) if (!SAFE_BUILD_KEYS.has(key)) risks.add(`build.${key}`);
    const context = typeof build["context"] === "string" ? build["context"] : null;
    if (context !== null && (context.includes("://") || !inside(context))) risks.add(`build:${context}`);
    if (context !== null && typeof build["dockerfile"] === "string" && !inside(resolve(context, build["dockerfile"])))
      risks.add(`build:${build["dockerfile"]}`);
    for (const tag of list(build["tags"])) if (!own(tag)) risks.add("build.tags");
    for (const source of list(build["cache_from"]))
      if (typeof source !== "string" || (source.includes("type=") && !source.includes("type=registry")))
        risks.add("build.cache_from");
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
    // Only a name and labels; ipam, ipv6 and drivers can change routing on the host.
    if (Object.keys(n).some((key) => !["name", "labels", "external"].includes(key))) risks.add(`network:${name}`);
    if (n["name"] === SHARED_NETWORK) continue;
    const own = typeof n["name"] !== "string" || n["name"] === `${project}_${name}`;
    if (!own || n["external"] === true) risks.add(`network:${name}`);
  }
  for (const section of ["secrets", "configs"])
    for (const entry of Object.values(record(top[section]))) {
      const file = record(entry)["file"];
      if (typeof file === "string" && !inside(file)) risks.add(`file:${resolve(file)}`);
      if (record(entry)["environment"] !== undefined) risks.add(`${section}.environment`);
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

/**
 * K-818: `docker compose config` inlines `include` and `extends`, so their files and env files never show
 * in its output. The raw Compose files of the app must not use them without an allowance.
 */
export function rawRisks(text: string): Array<string> {
  const risks = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.startsWith("include:")) risks.add("include");
    if (line.trimStart().startsWith("extends:")) risks.add("extends");
  }
  return [...risks];
}

/** K-818: the secret and config files of a config, checked again right before `up`. */
export function fileSources(config: unknown): Array<string> {
  const top = record(config);
  return ["secrets", "configs"].flatMap((section) =>
    Object.values(record(top[section])).flatMap((entry) => {
      const file = record(entry)["file"];
      return typeof file === "string" ? [file] : [];
    }),
  );
}
