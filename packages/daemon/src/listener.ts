// K-1751: the user that listens on a loopback TCP port, so a stale attester port that another user took is refused.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Platform } from "./service.ts";

/** The uid of the listener on `port` in one `/proc/net/tcp` or `/proc/net/tcp6` table (state 0A is LISTEN). */
export function procListenerUid(table: string, port: number): number | null {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  for (const line of table.split("\n").slice(1)) {
    const fields = line
      .trim()
      .split(" ")
      .filter((field) => field !== "");
    const local = fields[1] ?? "";
    if (fields[3] !== "0A" || local.slice(local.lastIndexOf(":") + 1).toUpperCase() !== hex) continue;
    const uid = Number(fields[7]);
    if (Number.isInteger(uid)) return uid;
  }
  return null;
}

/** The uid of the listener in `lsof -F u` output: one `u<uid>` line per process. Several users answer null. */
export function lsofListenerUid(output: string): number | null {
  const uids = new Set(
    output
      .split("\n")
      .filter((line) => line.startsWith("u"))
      .map((line) => Number(line.slice(1)))
      .filter((uid) => Number.isInteger(uid)),
  );
  const [uid] = uids;
  return uids.size === 1 && uid !== undefined ? uid : null;
}

/**
 * The uid of the listener on a loopback `port`, or null when no one listens or the daemon cannot see it. On macOS,
 * `lsof` shows only the daemon user's own processes unless it runs as root, so another user's listener reads as null.
 */
export function listenerUid(platform: Platform, port: number): number | null {
  if (platform === "linux") {
    for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      try {
        const uid = procListenerUid(readFileSync(table, "utf8"), port);
        if (uid !== null) return uid;
      } catch {
        // A missing table (no IPv6) holds no listener.
      }
    }
    return null;
  }
  const lsof = spawnSync("lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fu"], { encoding: "utf8" });
  return lsof.status === 0 ? lsofListenerUid(lsof.stdout) : null;
}

/** The TCP port of an attester address. */
export const portOf = (address: string) => {
  const url = new URL(address);
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
};
