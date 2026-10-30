import { parseSiteInput } from "@kitshn/edge/sites";
import { lstatSync } from "node:fs";
import { createConnection } from "node:net";

/** One live site in `sites.json` (K-1104). */
export interface SiteEntry {
  readonly name: string;
  readonly target: string;
  readonly dev: boolean;
  /** K-212: `kitshn expose --time`: the end time that the new card gets, in milliseconds. */
  readonly endsAt?: number;
  /** K-1104: `kitshn expose --circle`: the circle id of the new card; kitshn checks it (K-718). */
  readonly circle?: string;
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * `kitshn expose 5173`, `localhost:5173`, `http://127.0.0.1:5173/` or `/run/app.sock`: the target that the tunnel
 * sends to (K-607), or why not (K-1131).
 */
export function targetOf(value: string): string | { readonly error: string } {
  const input = parseSiteInput(value);
  switch (input.kind) {
    case "port":
      return `http://localhost:${input.port}`;
    case "socket":
      return `unix:${input.path}`;
    case "remote":
      return {
        error: `${input.host} is another host; kitshn exposes servers of this machine, such as localhost:5173.`,
      };
    case "invalid":
      return { error: input.reason };
  }
}

export function addSite(sites: ReadonlyArray<SiteEntry>, entry: SiteEntry): Array<SiteEntry> | string {
  if (!LABEL.test(entry.name)) return `The name ${entry.name} may use only a to z, 0 to 9 and dashes.`;
  return [...sites.filter((site) => site.name !== entry.name), entry].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/** Checks the entries of `sites.json`; anything else means the file is broken. */
export function parseSiteFile(value: unknown): Array<SiteEntry> | null {
  if (!Array.isArray(value)) return null;
  const sites: Array<SiteEntry> = [];
  for (const item of value) {
    const entry = item as Partial<Record<keyof SiteEntry, unknown>>;
    if (typeof entry.name !== "string" || typeof entry.target !== "string") return null;
    if (
      !LABEL.test(entry.name) ||
      !(entry.target.startsWith("unix:/") || entry.target.startsWith("http://localhost:"))
    ) {
      return null;
    }
    const { endsAt, circle } = entry;
    sites.push({
      name: entry.name,
      target: entry.target,
      dev: entry.dev === true,
      ...(typeof endsAt === "number" && Number.isFinite(endsAt) ? { endsAt } : {}),
      ...(typeof circle === "string" && circle !== "" ? { circle } : {}),
    });
  }
  return sites;
}

/** A socket file itself, not a link, so a link in the folder of an app cannot point a check elsewhere. */
export function isSocketFile(path: string): boolean {
  try {
    return lstatSync(path).isSocket();
  } catch {
    return false;
  }
}

/**
 * K-1107: the daemon tries the port or socket of each site, on the machine only. A port counts as up
 * when it answers on IPv4 or IPv6, because dev servers such as Vite often listen on ::1 only.
 */
export async function probe(target: string, timeoutMs = 2000): Promise<boolean> {
  if (target.startsWith("unix:")) {
    const path = target.slice("unix:".length);
    return isSocketFile(path) && connects({ path }, timeoutMs);
  }
  const port = Number(new URL(target).port);
  return (
    (await connects({ host: "127.0.0.1", port }, timeoutMs)) || connects({ host: "::1", port }, timeoutMs)
  );
}

function connects(
  options: { path: string } | { host: string; port: number },
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
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
