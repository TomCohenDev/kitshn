import { createHash } from "node:crypto";
import { join } from "node:path";

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
