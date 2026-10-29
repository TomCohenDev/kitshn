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

/** The old copies of `binary` in its folder, which the next start deletes. */
export const oldBinaries = (binary: string, names: ReadonlyArray<string>) =>
  names
    .filter((name) => name.startsWith(`${basename(binary, ".exe")}.old-`) && name.endsWith(".exe"))
    .map((name) => join(dirname(binary), name));

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
