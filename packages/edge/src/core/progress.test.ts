import { describe, expect, it } from "vitest";
import {
  currentStep,
  failProgress,
  finishProgress,
  progressBar,
  progressShown,
  reachStep,
  startProgress,
  withRetry,
} from "./progress.ts";

const PLAN = [
  { label: "one", expectedMs: 1_000 },
  { label: "two", expectedMs: 3_000 },
];

describe("action progress (K-538)", () => {
  it("runs its steps in order to the checkmark, which shows for a moment", () => {
    let progress = startProgress("Act", PLAN, 0, null);
    expect(progressBar(progress, 0)).toEqual({ from: 0, to: 0.9 / 4, ms: 900 });
    // A step that takes longer than expected waits at its hold point: the bar never says done too early.
    expect(progressBar(progress, 5_000)).toEqual({ from: 0.9 / 4, to: 0.9 / 4, ms: 0 });
    progress = reachStep(progress, 1, 2_000);
    // Never back: the state may name an older step again.
    expect(reachStep(progress, 0, 2_500)).toBe(progress);
    expect(currentStep(progress)).toBe(1);
    expect(progressBar(progress, 2_000)).toEqual({ from: 1 / 4, to: (1 + 2.7) / 4, ms: 2_700 });
    progress = finishProgress(progress, 4_000);
    expect(progress.outcome).toEqual({ state: "done", at: 4_000 });
    expect(progressBar(progress, 4_000)).toEqual({ from: 1, to: 1, ms: 0 });
    expect(progressShown(progress, 6_999)).toBe(true);
    expect(progressShown(progress, 7_000)).toBe(false);
    // The next run of the same action expects the times this run took.
    const next = startProgress("Act", PLAN, 10_000, progress);
    expect(next.steps.map((step) => step.expectedMs)).toEqual([2_000, 2_000]);
    // A run that replaces a running one, such as a second job on the card, keeps what that one learned.
    expect(startProgress("Act", PLAN, 11_000, next).steps.map((step) => step.expectedMs)).toEqual([
      2_000, 2_000,
    ]);
    expect(startProgress("Other", PLAN, 10_000, progress).steps.map((step) => step.expectedMs)).toEqual([
      1_000, 3_000,
    ]);
  });

  it("stands still while its step waits for a retry, and moves on when the step does", () => {
    const retrying = withRetry(startProgress("Act", PLAN, 0, null), {
      reason: "Cloudflare: 503",
      at: 300_000,
    });
    expect(progressBar(retrying, 450)).toEqual({ from: 450 / 4_000, to: 450 / 4_000, ms: 0 });
    expect(progressShown(retrying, 1_000_000)).toBe(true);
    expect(finishProgress(retrying, 2_000).retry).toBeNull();
  });

  it("stops at the failed step with its reason and stays shown", () => {
    const failed = failProgress(reachStep(startProgress("Act", PLAN, 0, null), 1, 500), "No route.", 900);
    expect(failed.outcome).toEqual({ state: "failed", at: 900, reason: "No route." });
    expect(currentStep(failed)).toBe(1);
    expect(progressBar(failed, 900)).toEqual({ from: 0.25, to: 0.25, ms: 0 });
    expect(progressShown(failed, 1_000_000)).toBe(true);
    // A failure ends the action: no later state moves or finishes it.
    expect(finishProgress(reachStep(failed, 2, 1_000), 1_000)).toBe(failed);
    // A failed run measured nothing, so the next run keeps the times that it expected.
    expect(startProgress("Act", PLAN, 0, failed).steps.map((step) => step.expectedMs)).toEqual([
      1_000, 3_000,
    ]);
  });
});
