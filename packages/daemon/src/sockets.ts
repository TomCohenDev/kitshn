import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type SiteEntry, addSite } from "./sites.ts";

/**
 * K-607: the most bytes of a Unix socket path, without the closing NUL: `sun_path` holds 108 bytes on Linux and 104
 * on macOS.
 */
export const SOCKET_PATH_LIMIT = { linux: 107, darwin: 103 } as const;

/** A short, stable folder name for a card id (K-804 allows 56 characters) or a job run, so its length is fixed. */
const shortName = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

/** K-607: the sockets folder of a Compose app, `$KITSHN_SOCKET_DIR`. */
export const appSocketFolder = (data: string, project: string) => join(data, "s", shortName(project));

/** K-1813: the private folder of the restic proxy socket of one backup or restore job. */
export const jobSocketFolder = (data: string, run: string) => join(data, "run", shortName(run));

/** K-607: why the system cannot bind or connect to `path`, or null when it fits. */
export function socketPathProblem(path: string, platform: NodeJS.Platform): string | null {
  const limit = platform === "darwin" ? SOCKET_PATH_LIMIT.darwin : SOCKET_PATH_LIMIT.linux;
  const bytes = Buffer.byteLength(path);
  return bytes > limit
    ? `the socket path ${path} has ${bytes} bytes, more than the ${limit} that this system allows; use a shorter data folder for the daemon (K-607)`
    : null;
}

/** The `sites.json` of the daemon; `read` gives null when the file is broken. */
export interface SiteStore {
  read(): ReadonlyArray<SiteEntry> | null;
  write(sites: ReadonlyArray<SiteEntry>): void;
}

/**
 * K-607, K-818: `up` replaces the stopped old containers, so from its start only the new socket can serve. The site
 * points there before `up`, so an `up` that fails half-way still routes to the services that came up.
 */
export async function upOnSocket(
  store: SiteStore,
  site: { readonly name: string; readonly socketPath: string },
  up: () => Promise<void>,
) {
  const sites = store.read();
  if (sites === null) throw new Error("sites.json is broken; fix it, then deploy again");
  const next = addSite(sites, { name: site.name, target: `unix:${site.socketPath}`, dev: false });
  if (typeof next === "string") throw new Error(next);
  store.write(next);
  await up();
}

/** K-607: the sockets folder of an app before the short one; a file in it that is no socket keeps it. */
export function removeOldSockets(folder: string): string {
  if (!existsSync(folder)) return "";
  try {
    if (readdirSync(folder, { withFileTypes: true }).some((entry) => !entry.isSocket()))
      return `kitshn keeps ${folder}: it holds more than sockets.\n`;
    rmSync(folder, { recursive: true, force: true });
    return `$ remove the old sockets folder ${folder}\n`;
  } catch (error) {
    return `kitshn could not remove ${folder}: ${String(error)}\n`;
  }
}
