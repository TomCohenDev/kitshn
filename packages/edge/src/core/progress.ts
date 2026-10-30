// K-538: the progress of an action that a person or an agent started on a card, as every client shows it.

export interface ProgressStep {
  readonly label: string;
  /** How long kitshn expects the step to take: its time in the last run that ended well, else a default. */
  readonly expectedMs: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

export type ProgressOutcome =
  | { readonly state: "running" }
  | { readonly state: "done"; readonly at: number }
  | { readonly state: "failed"; readonly at: number; readonly reason: string };

export interface ActionProgress {
  /** The name of the action, as its button says it: "Take the address". */
  readonly action: string;
  readonly steps: ReadonlyArray<ProgressStep>;
  readonly outcome: ProgressOutcome;
  /** The step that runs got no clear answer from Cloudflare; kitshn tries again at `at` (K-407, K-410). */
  readonly retry: { readonly reason: string; readonly at: number } | null;
}

export interface PlannedStep {
  readonly label: string;
  readonly expectedMs: number;
}

/** The sticker of a done action shows its checkmark this long, then goes. */
export const DONE_SHOWN_MS = 3_000;

/** A learned time is never shorter than this, so a step that ended at once still moves the bar next time. */
const MIN_EXPECTED_MS = 500;

/**
 * Starts an action at its first step. A step takes its time from `previous` when that is a run of the same action
 * with the same steps: the time it took when that run ended well, else the time that run expected. So the estimate
 * follows the real speed of that card, and a run that another one replaced keeps what it learned.
 */
export function startProgress(
  action: string,
  plan: ReadonlyArray<PlannedStep>,
  now: number,
  previous: ActionProgress | null,
): ActionProgress {
  if (plan.length === 0) throw new Error(`The action ${action} has no steps.`);
  const learned =
    previous?.action === action &&
    previous.steps.length === plan.length &&
    previous.steps.every((step, index) => step.label === plan[index]?.label)
      ? previous.steps
      : null;
  return {
    action,
    outcome: { state: "running" },
    retry: null,
    steps: plan.map((step, index) => {
      const before = learned?.[index];
      const measured =
        previous?.outcome.state === "done" && before?.startedAt != null && before.endedAt != null
          ? Math.max(MIN_EXPECTED_MS, before.endedAt - before.startedAt)
          : null;
      return {
        label: step.label,
        expectedMs: measured ?? before?.expectedMs ?? step.expectedMs,
        startedAt: index === 0 ? now : null,
        endedAt: null,
      };
    }),
  };
}

/** The index of the step that runs now; the number of steps when all ended. */
export const currentStep = (progress: ActionProgress) => {
  const index = progress.steps.findIndex((step) => step.endedAt === null);
  return index < 0 ? progress.steps.length : index;
};

/**
 * Moves a running action on to step `index`: every step before it ends now. It never goes back, so a caller can
 * pass the step that the state shows at any time.
 */
export function reachStep(progress: ActionProgress, index: number, now: number): ActionProgress {
  if (progress.outcome.state !== "running") return progress;
  const target = Math.min(index, progress.steps.length - 1);
  if (target <= currentStep(progress)) return progress;
  return {
    ...progress,
    steps: progress.steps.map((step, at) =>
      at < target
        ? { ...step, startedAt: step.startedAt ?? now, endedAt: step.endedAt ?? now }
        : at === target
          ? { ...step, startedAt: now }
          : step,
    ),
  };
}

/** Sets or clears the retry of the step that runs. */
export function withRetry(progress: ActionProgress, retry: ActionProgress["retry"]): ActionProgress {
  if (progress.outcome.state !== "running") return progress;
  return { ...progress, retry };
}

export function finishProgress(progress: ActionProgress, now: number): ActionProgress {
  if (progress.outcome.state !== "running") return progress;
  return {
    ...progress,
    retry: null,
    outcome: { state: "done", at: now },
    steps: progress.steps.map((step) => ({
      ...step,
      startedAt: step.startedAt ?? now,
      endedAt: step.endedAt ?? now,
    })),
  };
}

/** The step that runs keeps no end, so the list names the step that failed. */
export function failProgress(progress: ActionProgress, reason: string, now: number): ActionProgress {
  if (progress.outcome.state !== "running") return progress;
  return { ...progress, retry: null, outcome: { state: "failed", at: now, reason } };
}

export interface ProgressBar {
  /** The share of the bar that shows now, from 0 to 1. */
  readonly from: number;
  /** The share where the step that runs is expected to end. */
  readonly to: number;
  /** How long the bar takes from `from` to `to`; 0 when it stands still. */
  readonly ms: number;
}

/** A step that takes longer than expected waits at this share of its part, so the bar never says done too early. */
const STEP_HOLD = 0.9;

/**
 * The bar of an action at `now`: each step has its expected time as its part of the bar. The bar moves through the
 * part of the step that runs in one straight line, from where it is to that step's hold point.
 */
export function progressBar(progress: ActionProgress, now: number): ProgressBar {
  const total = progress.steps.reduce((sum, step) => sum + step.expectedMs, 0);
  if (progress.outcome.state === "done" || total <= 0) return { from: 1, to: 1, ms: 0 };
  const index = currentStep(progress);
  const before = progress.steps.slice(0, index).reduce((sum, step) => sum + step.expectedMs, 0);
  const step = progress.steps[index];
  if (!step || progress.outcome.state === "failed")
    return { from: before / total, to: before / total, ms: 0 };
  const hold = step.expectedMs * STEP_HOLD;
  const elapsed = Math.min(hold, Math.max(0, now - (step.startedAt ?? now)));
  // A step that waits for a retry stands still where it is.
  if (progress.retry !== null)
    return { from: (before + elapsed) / total, to: (before + elapsed) / total, ms: 0 };
  return { from: (before + elapsed) / total, to: (before + hold) / total, ms: Math.round(hold - elapsed) };
}

/** True while a client shows the action: it runs, it failed and nobody dismissed it, or it ended a moment ago. */
export const progressShown = (progress: ActionProgress, now: number) =>
  progress.outcome.state !== "done" || now - progress.outcome.at < DONE_SHOWN_MS;

/** The step list for a tooltip: one line per step, with ✓ for a done step, → for the one that runs, ↻ for a retry and ✗ for a failure. */
export function progressLines(progress: ActionProgress): Array<string> {
  const index = currentStep(progress);
  const failed = progress.outcome.state === "failed";
  return progress.steps.map((step, at) => {
    const mark = at < index ? "✓" : at === index ? (failed ? "✗" : progress.retry ? "↻" : "→") : "·";
    return `${mark} ${step.label}`;
  });
}
