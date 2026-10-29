// K-620: the swap of the daemon binary at an update. On Windows a running .exe cannot be replaced, only renamed, and a
// virus scan can hold the new file open for a moment.
import { basename, dirname, join } from "node:path";

export interface SwapFiles {
  readonly rename: (from: string, to: string) => void;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Each update renames the running binary to a name of its own, so an old copy that still runs never blocks one. */
export const oldBinaryName = (binary: string, now: number) =>
  join(dirname(binary), `${basename(binary, ".exe")}.old-${now}.exe`);

/**
 * The old copies of `binary` in its folder, which the next start deletes. K-629: the newest stays, because it is the
 * previous daemon, the way back of the last update.
 */
export function oldBinaries(binary: string, names: ReadonlyArray<string>): Array<string> {
  const prefix = `${basename(binary, ".exe")}.old-`;
  const old = names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".exe"))
    .map((name) => ({ name, at: Number(name.slice(prefix.length, -".exe".length)) }))
    .toSorted((a, b) => a.at - b.at);
  return old.slice(0, -1).map(({ name }) => join(dirname(binary), name));
}

/** Where an update writes the new binary before the swap. Windows runs it for the start check, so it ends in .exe. */
export const nextBinaryName = (binary: string, windows: boolean) =>
  windows ? join(dirname(binary), `${basename(binary, ".exe")}.new.exe`) : `${binary}.new`;

/** K-629: the time that a new daemon has to reach kitshn before the previous one comes back. */
export const UPDATE_DEADLINE_MS = 5 * 60_000;

/** K-629: `<data>/update.json`, written before the swap and read by the next start. */
export interface UpdateMarker {
  readonly jobId: number;
  readonly from: string;
  readonly to: string;
  /** The previous binary: `kitshn.old` beside the binary, or `kitshn.old-<time>.exe` on Windows (K-620). */
  readonly previous: string;
  readonly deadline: number;
  readonly state: "pending" | "rolled-back";
  readonly reason?: string;
}

export function parseMarker(value: unknown): UpdateMarker | null {
  if (typeof value !== "object" || value === null) return null;
  const marker = value as Record<string, unknown>;
  if (
    typeof marker["jobId"] !== "number" ||
    typeof marker["from"] !== "string" ||
    typeof marker["to"] !== "string" ||
    typeof marker["previous"] !== "string" ||
    typeof marker["deadline"] !== "number" ||
    (marker["state"] !== "pending" && marker["state"] !== "rolled-back")
  )
    return null;
  return {
    jobId: marker["jobId"],
    from: marker["from"],
    to: marker["to"],
    previous: marker["previous"],
    deadline: marker["deadline"],
    state: marker["state"],
    ...(typeof marker["reason"] === "string" ? { reason: marker["reason"] } : {}),
  };
}

/** K-629: what a start does with the marker of an update. */
export type StartStep =
  | { readonly kind: "none" }
  /** The new daemon runs: it reports the update once kitshn accepts it, or rolls back at the deadline. */
  | { readonly kind: "wait"; readonly jobId: number; readonly deadline: number }
  | { readonly kind: "roll-back"; readonly reason: string }
  /** The previous daemon runs again, so it reports why the update failed. */
  | { readonly kind: "report"; readonly jobId: number; readonly reason: string };

export function startStep(marker: UpdateMarker | null, version: string, now: number): StartStep {
  if (marker === null) return { kind: "none" };
  if (marker.state === "rolled-back")
    return { kind: "report", jobId: marker.jobId, reason: marker.reason ?? "The previous daemon came back." };
  if (version !== marker.to)
    return {
      kind: "report",
      jobId: marker.jobId,
      reason: `The daemon started on ${version}, not on edge-${marker.to}.`,
    };
  // A daemon that crashes before kitshn accepts it starts again; the first start after the deadline rolls back.
  if (now >= marker.deadline)
    return { kind: "roll-back", reason: "The new daemon did not reach kitshn within 5 minutes." };
  return { kind: "wait", jobId: marker.jobId, deadline: marker.deadline };
}

/**
 * K-629: puts the previous binary back in place of the running one. Unix replaces a running binary with one rename;
 * Windows renames the running .exe out of the way first (K-620).
 */
export async function restorePrevious(
  files: SwapFiles,
  binary: string,
  previous: string,
  windows: boolean,
  now: number,
  sleep: (ms: number) => Promise<void> = wait,
): Promise<void> {
  if (windows) await swapBinary(files, binary, previous, oldBinaryName(binary, now), 5, sleep);
  else files.rename(previous, binary);
}

/**
 * Puts `next` in place of the running `binary`, keeping it as `old` until the new one runs. A failed rename of `next`
 * is tried again; when it still fails, `old` goes back to `binary`, so the task always finds a binary. Throws with
 * what happened.
 */
export async function swapBinary(
  files: SwapFiles,
  binary: string,
  next: string,
  old: string,
  tries = 5,
  sleep: (ms: number) => Promise<void> = wait,
): Promise<void> {
  /** The error of the last try, or null when one try worked. */
  const retry = async (from: string, to: string): Promise<unknown> => {
    let last: unknown = null;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        files.rename(from, to);
        return null;
      } catch (error) {
        last = error;
        if (attempt < tries) await sleep(500 * attempt);
      }
    }
    return last;
  };
  files.rename(binary, old);
  const failed = await retry(next, binary);
  if (failed === null) return;
  if ((await retry(old, binary)) === null)
    throw new Error(`the new binary did not go in place (${String(failed)}); the old one is back.`);
  throw new Error(
    `the new binary did not go in place (${String(failed)}), and the old one could not go back: it is at ${old}.`,
  );
}
