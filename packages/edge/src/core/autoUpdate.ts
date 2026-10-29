// K-626 to K-629: automatic daemon updates, one machine at a time, from the update jobs of one release.
import type { MachineStatus } from "./machine.ts";

/** K-617: a local build names no release, so there is nothing to update a daemon to. */
export const isRelease = (version: string) => /^[0-9a-f]{12}$/.test(version);

/** K-627: the newest update job of the release on one machine. "closed": it failed only because the connection closed. */
export interface UpdateJob {
  readonly state: "queued" | "sent" | "done" | "failed" | "closed";
  readonly output: string;
}

/** K-628: what the card shows about the update of its daemon to the release of the Worker. */
export type DaemonUpdate =
  | { readonly state: "updating" }
  | { readonly state: "updated" }
  | { readonly state: "failed"; readonly reason: string };

/** The daemon as kitshn sees it now: its status while it is online with one, else null. */
export type LiveStatus = Pick<MachineStatus, "version" | "capabilities"> | null;

/** The last line of a job's output, which holds the error of a failed update. */
const lastLine = (output: string) =>
  output
    .trim()
    .split("\n")
    .findLast((line) => line.trim() !== "")
    ?.trim() ?? "The update failed without output.";

/** K-627: the update state of one machine for `version`, or null when no update job of that release exists. */
export function daemonUpdate(
  version: string,
  job: UpdateJob | undefined,
  status: LiveStatus,
): DaemonUpdate | null {
  if (!job) return null;
  if (job.state === "queued" || job.state === "sent") return { state: "updating" };
  if (job.state === "failed") return { state: "failed", reason: lastLine(job.output) };
  if (status !== null && status.version !== version)
    return { state: "failed", reason: `The daemon came back on edge-${status.version}.` };
  if (status !== null) return { state: "updated" };
  // K-629: a daemon sends the result only after the new one reached kitshn, so a done job of an offline machine
  // updated; a closed connection without a result is a restart that has not reported yet.
  return job.state === "done" ? { state: "updated" } : { state: "updating" };
}

export interface AutoUpdateMachine {
  readonly id: string;
  readonly order: number;
  /** K-626: absent or true means on. */
  readonly autoUpdate: boolean;
  /** K-1708: a machine without a key gets no jobs. */
  readonly hasKey: boolean;
  readonly status: LiveStatus;
  readonly update: DaemonUpdate | null;
}

/**
 * K-627: the one machine that gets the next automatic update, or null. Nothing while kitshn is paused, while one
 * machine updates, or after one failed on this release; then the first machine in the owner's order that is BEHIND.
 */
export function nextAutoUpdate(
  version: string,
  paused: boolean,
  machines: ReadonlyArray<AutoUpdateMachine>,
): string | null {
  if (!isRelease(version) || paused) return null;
  if (machines.some((machine) => machine.update !== null && machine.update.state !== "updated")) return null;
  const behind = machines.filter(
    (machine) =>
      machine.autoUpdate &&
      machine.hasKey &&
      machine.update === null &&
      machine.status !== null &&
      isRelease(machine.status.version) &&
      machine.status.version !== version &&
      (machine.status.capabilities ?? []).includes("update"),
  );
  return behind.toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id))[0]?.id ?? null;
}
