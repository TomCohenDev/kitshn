import { resolve } from "node:path";

/**
 * K-818: the settings of a Compose app that give it more than its own folders: root on the machine, the
 * machine's files, or another container's namespaces. Each comes back as a name that an allow list entry
 * can name, for example `privileged`, `cap_add:NET_ADMIN`, `pid:host` or `bind:/var/run/docker.sock`.
 */
export function composeRisks(
  config: unknown,
  /** The app's own folders: its source, data, logs and sockets. */
  roots: ReadonlyArray<string>,
  /** Follows symlinks of a path that exists, so a link in the repo cannot point out of the app's folders. */
  realpath: (path: string) => string,
): Array<string> {
  const risks = new Set<string>();
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const inside = (path: string) => {
    const real = realpath(resolve(path));
    return roots.some((root) => real === root || real.startsWith(`${root}/`));
  };
  const top = record(config);
  for (const service of Object.values(record(top["services"]))) {
    const s = record(service);
    if (s["privileged"] === true) risks.add("privileged");
    for (const cap of Array.isArray(s["cap_add"]) ? s["cap_add"] : []) risks.add(`cap_add:${String(cap)}`);
    if (Array.isArray(s["devices"]) && s["devices"].length > 0) risks.add("devices");
    if (Array.isArray(s["device_cgroup_rules"]) && s["device_cgroup_rules"].length > 0) risks.add("devices");
    for (const key of ["pid", "ipc", "network_mode", "userns_mode", "uts", "cgroup"]) {
      const value = s[key];
      if (typeof value !== "string") continue;
      if (value === "host") risks.add(`${key}:host`);
      else if (value.startsWith("container:") || (key !== "network_mode" && value.startsWith("service:")))
        risks.add(`${key}:container`);
    }
    for (const option of Array.isArray(s["security_opt"]) ? s["security_opt"].map(String) : [])
      if (option.includes("unconfined") || option.replace("=", ":") === "no-new-privileges:false")
        risks.add(`security_opt:${option}`);
    for (const volume of Array.isArray(s["volumes"]) ? s["volumes"] : []) {
      const v = record(volume);
      if (v["type"] === "bind" && typeof v["source"] === "string" && !inside(v["source"]))
        risks.add(`bind:${resolve(v["source"])}`);
    }
    const build = record(s["build"]);
    if (typeof build["context"] === "string" && !build["context"].includes("://") && !inside(build["context"]))
      risks.add(`build:${resolve(build["context"])}`);
  }
  for (const section of ["secrets", "configs"]) {
    for (const entry of Object.values(record(top[section]))) {
      const file = record(entry)["file"];
      if (typeof file === "string" && !inside(file)) risks.add(`file:${resolve(file)}`);
    }
  }
  for (const volume of Object.values(record(top["volumes"]))) {
    const device = record(record(volume)["driver_opts"])["device"];
    if (typeof device === "string" && device.startsWith("/") && !inside(device)) risks.add(`bind:${resolve(device)}`);
  }
  return [...risks].sort();
}
