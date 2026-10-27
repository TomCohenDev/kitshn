import { createConnection } from "node:net";

/** One live site in `sites.json` (K-1104). */
export interface SiteEntry {
  readonly name: string;
  readonly target: string;
  readonly dev: boolean;
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** `kitshn expose 5173` or `kitshn expose /run/app.sock`: the target that the tunnel sends to (K-607). */
export function targetOf(value: string): string | null {
  if (/^\d{1,5}$/.test(value) && Number(value) > 0 && Number(value) < 65536)
    return `http://localhost:${value}`;
  if (value.startsWith("/")) return `unix:${value}`;
  return null;
}

export function addSite(sites: ReadonlyArray<SiteEntry>, entry: SiteEntry): Array<SiteEntry> | string {
  if (!LABEL.test(entry.name)) return `The name ${entry.name} may use only a to z, 0 to 9 and dashes.`;
  return [...sites.filter((site) => site.name !== entry.name), entry].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/** K-1107: the daemon tries the port or socket of each site, on the machine only. */
export function probe(target: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const options = target.startsWith("unix:")
      ? { path: target.slice("unix:".length) }
      : { host: "127.0.0.1", port: Number(new URL(target).port) };
    const socket = createConnection(options);
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
