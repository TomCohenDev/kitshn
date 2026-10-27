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
  for (const [serviceName, service] of Object.entries(record(top["services"]))) {
    const s = record(service);
    for (const key of Object.keys(s)) if (!SAFE_SERVICE_KEYS.has(key) && !key.startsWith("x-")) risks.add(key);
    // A built image or a container name of another app would take its place on this machine. A plain
    // prefix is not enough: the project a-pr-1 is a prefix of the project a-pr-12.
    const ownName = `${project}-${serviceName}`;
    const own = (name: unknown) => {
      if (name === ownName) return true;
      if (typeof name !== "string" || !name.startsWith(`${ownName}:`)) return false;
      const tag = name.slice(ownName.length + 1);
      return tag !== "" && !tag.includes(":") && !tag.includes("/") && !tag.includes("@");
    };
    if (s["build"] !== undefined && s["image"] !== undefined && !own(s["image"])) risks.add("image");
    if (s["container_name"] !== undefined && s["container_name"] !== ownName) risks.add("container_name");
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
      if (name !== "default" && !Object.hasOwn(record(top["networks"]), name))
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
    // The setting names the Docker network, so `network:kitshn-edge` holds whatever key the file uses.
    // Compose gives each service its name as an alias on a shared network such as kitshn-edge, so a
    // service there can take the traffic of another app's service of the same name.
    const risk = `network:${typeof n["name"] === "string" ? n["name"] : name}`;
    // Only a name and labels; ipam, ipv6 and drivers can change routing on the host.
    if (Object.keys(n).some((key) => !["name", "labels", "external"].includes(key))) risks.add(risk);
    const own = typeof n["name"] !== "string" || n["name"] === `${project}_${name}`;
    if (!own || n["external"] === true) risks.add(risk);
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

const isMapping = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * K-818: `docker compose config` inlines `include` and `extends`, so their files and env files never show
 * in its output. The raw Compose files of the app must not use them without an allowance. A real YAML
 * parse sees them in every form: quoted keys, flow style, JSON and merge keys. Throws on a file that is
 * not one YAML mapping, also on more than one document.
 */
export function rawRisks(text: string): Array<string> {
  const document: unknown = Bun.YAML.parse(text);
  if (!isMapping(document)) throw new Error("a Compose file must be one YAML mapping");
  const services = record(document["services"]);
  // Bun expands merge keys; one that stays is a form that Compose may read differently.
  if ("<<" in document || Object.values(services).some((service) => "<<" in record(service)))
    throw new Error("a Compose file has a merge key that does not expand");
  const risks: Array<string> = [];
  if ("include" in document) risks.push("include");
  if (Object.values(services).some((service) => "extends" in record(service))) risks.push("extends");
  return risks;
}

/** K-818: the Compose file names that Compose finds on its own, in its order; it takes the first of each. */
const DEFAULT_FILES = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];
const OVERRIDE_FILES = [
  "compose.override.yml",
  "compose.override.yaml",
  "docker-compose.override.yml",
  "docker-compose.override.yaml",
];

/**
 * K-818: the Compose files of an app, as absolute paths. The daemon passes them with `-f`, so a
 * `COMPOSE_FILE` in the params cannot add files. `file` is the recipe's file, relative to the source.
 * Throws when a file is missing or resolves out of the source.
 */
export function composeFiles(
  source: string,
  file: string | null,
  exists: (path: string) => boolean,
  real: (path: string) => string,
): Array<string> {
  const inSource = (path: string) => path.startsWith(`${source}/`);
  if (file !== null) {
    const path = resolve(source, file);
    if (file.startsWith("/") || !inSource(path)) throw new Error(`the Compose file ${file} is not inside the repo`);
    if (!exists(path)) throw new Error(`the repo has no Compose file ${file}`);
    if (!inSource(real(path))) throw new Error(`the Compose file ${file} links out of the repo`);
    return [path];
  }
  const first = (names: ReadonlyArray<string>) => names.map((name) => join(source, name)).find(exists);
  const main = first(DEFAULT_FILES);
  if (main === undefined) throw new Error(`the repo has none of the Compose files ${DEFAULT_FILES.join(", ")}`);
  const override = first(OVERRIDE_FILES);
  const files = override === undefined ? [main] : [main, override];
  for (const path of files)
    if (!inSource(real(path))) throw new Error(`the Compose file ${path} links out of the repo`);
  return files;
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
