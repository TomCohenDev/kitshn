// K-626 to K-629: automatic daemon updates, one machine at a time, as one rollout that survives a deploy.
import type { MachineStatus } from "./machine.ts";

/** K-617: a local build names no release, so there is nothing to update a daemon to. */
export const isRelease = (version: string) => /^[0-9a-f]{12}$/.test(version);

/**
 * K-627: the one rollout of kitshn, kept in `meta`. `step` is the machine that updates now, also after a deploy of
 * another release; `failed` stops the rest of `version`; `updated` lists the machines that reached `version`.
 */
export interface Rollout {
  readonly version: string;
  readonly step: {
    readonly machineId: string;
    readonly jobId: number;
    /** When kitshn sent the job; only a connection after it can show that the daemon came back. */
    readonly sentAt: number | null;
  } | null;
  readonly failed: { readonly machineId: string; readonly reason: string } | null;
  readonly updated: ReadonlyArray<string>;
}

export const NO_ROLLOUT: Rollout = { version: "", step: null, failed: null, updated: [] };

/** K-627: the job of the step. "closed": it failed only because the connection closed. "gone": expired or none. */
export interface StepJob {
  readonly state: "queued" | "sent" | "done" | "failed" | "closed" | "gone";
  readonly output: string;
}

/** The daemon as kitshn sees it now: its status and the start of its connection while online, else null. */
export type LiveStatus =
  (Pick<MachineStatus, "version" | "capabilities"> & { readonly connectedAt: number }) | null;

/** K-628: what the card shows about the update of its daemon. */
export type DaemonUpdate =
  | { readonly state: "updating" }
  | { readonly state: "updated" }
  | { readonly state: "failed"; readonly reason: string };

/** The last line of a job's output, which holds the error of a failed update. */
const lastLine = (output: string) =>
  output
    .trim()
    .split("\n")
    .findLast((line) => line.trim() !== "")
    ?.trim() ?? "The update failed without output.";

const withUpdated = (rollout: Rollout, machineId: string): Rollout => ({
  ...rollout,
  updated: rollout.updated.includes(machineId) ? rollout.updated : [...rollout.updated, machineId],
});

/**
 * K-627: moves the rollout on from what kitshn sees now. A step ends only when its machine is online and runs the
 * release, or fails; a machine that stays offline holds the rest, also after a `done` job. A failed machine that runs
 * the release later (a retry with "Update daemon") ends the failure.
 */
export function advanceRollout(
  rollout: Rollout,
  job: StepJob | null,
  statusOf: (machineId: string) => LiveStatus,
): Rollout {
  let next = rollout;
  const step = next.step;
  if (step) {
    const status = statusOf(step.machineId);
    // A connection that started after the job went out, so not the one that ran it.
    const later = status !== null && step.sentAt !== null && status.connectedAt > step.sentAt;
    if (job === null || job.state === "gone") next = { ...next, step: null };
    else if (job.state === "failed")
      next = { ...next, step: null, failed: { machineId: step.machineId, reason: lastLine(job.output) } };
    else if (status !== null && status.version === next.version)
      next = withUpdated({ ...next, step: null }, step.machineId);
    else if (status !== null && later && (job.state === "done" || job.state === "closed"))
      next = {
        ...next,
        step: null,
        failed: { machineId: step.machineId, reason: `The daemon came back on edge-${status.version}.` },
      };
  }
  const failed = next.failed;
  if (failed && statusOf(failed.machineId)?.version === next.version)
    next = withUpdated({ ...next, failed: null }, failed.machineId);
  return next;
}

export interface AutoUpdateMachine {
  readonly id: string;
  readonly order: number;
  /** K-626: absent or true means on. */
  readonly autoUpdate: boolean;
  /** K-1708: a machine without a key gets no jobs. */
  readonly hasKey: boolean;
  readonly status: LiveStatus;
}

/**
 * K-627: the one machine that gets the next automatic update, or null. Nothing while kitshn is paused, while a step
 * of any release runs, or after one failed on this release; then the first BEHIND machine in the owner's order.
 */
export function nextAutoUpdate(
  version: string,
  paused: boolean,
  rollout: Rollout,
  machines: ReadonlyArray<AutoUpdateMachine>,
): string | null {
  if (!isRelease(version) || paused || rollout.step !== null) return null;
  if (rollout.version === version && rollout.failed !== null) return null;
  const behind = machines.filter(
    (machine) =>
      machine.autoUpdate &&
      machine.hasKey &&
      machine.status !== null &&
      isRelease(machine.status.version) &&
      machine.status.version !== version &&
      (machine.status.capabilities ?? []).includes("update"),
  );
  return behind.toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id))[0]?.id ?? null;
}

/** K-627: the rollout with a new step; a new release starts a new rollout. */
export const startStep = (rollout: Rollout, version: string, machineId: string, jobId: number): Rollout => ({
  ...(rollout.version === version ? rollout : { ...NO_ROLLOUT, version }),
  step: { machineId, jobId, sentAt: null },
});

/**
 * K-627: the step went out. Delivery names the release of the Worker at that time (K-617), so a step queued before a
 * deploy moves to the new release.
 */
export function stepSent(rollout: Rollout, version: string, now: number): Rollout {
  if (rollout.step === null) return rollout;
  return {
    ...startStep(rollout, version, rollout.step.machineId, rollout.step.jobId),
    step: { ...rollout.step, sentAt: now },
  };
}

/** K-628: what the card of a machine shows for the release of the Worker. */
export function daemonUpdate(rollout: Rollout, machineId: string, version: string): DaemonUpdate | null {
  if (rollout.step?.machineId === machineId) return { state: "updating" };
  if (rollout.version !== version) return null;
  if (rollout.failed?.machineId === machineId) return { state: "failed", reason: rollout.failed.reason };
  return rollout.updated.includes(machineId) ? { state: "updated" } : null;
}

/** Reads the stored rollout; kitshn writes it, so another shape is a bug. */
export function parseRollout(text: string | null): Rollout {
  if (text === null) return NO_ROLLOUT;
  const value = JSON.parse(text) as Rollout;
  if (typeof value.version !== "string" || !Array.isArray(value.updated))
    throw new Error(`The stored daemon rollout does not parse: ${text.slice(0, 200)}`);
  return value;
}
