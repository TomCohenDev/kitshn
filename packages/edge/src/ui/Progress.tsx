import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  type ActionProgress,
  DONE_SHOWN_MS,
  currentStep,
  progressBar,
  progressLines,
} from "../core/progress.ts";
import { callApi } from "./store.ts";

/** The card starts a drag on a press; a link on it opens instead. */
const keepPress = (event: PointerEvent) => event.stopPropagation();

/** K-407, K-410: why a step waits, and when kitshn tries again. */
const retryText = (retry: NonNullable<ActionProgress["retry"]>) =>
  `${retry.reason} Next try at ${new Date(retry.at).toLocaleTimeString()}.`;

/** K-538: the tip of the sticker, with one line per step, so a hover shows what runs and what comes. */
function progressTip(progress: ActionProgress) {
  const { outcome, steps } = progress;
  const head =
    outcome.state === "failed"
      ? `${progress.action} failed: ${outcome.reason}`
      : outcome.state === "done"
        ? `${progress.action}: done.`
        : progress.retry
          ? `${progress.action}: step ${currentStep(progress) + 1} of ${steps.length} waits. ${retryText(progress.retry)}`
          : `${progress.action}: step ${currentStep(progress) + 1} of ${steps.length}.`;
  return [head, ...progressLines(progress), "The card panel lists the steps too."].join("\n");
}

/**
 * K-538: true while the checkmark of a done action shows. The client counts the time from when it saw the end, so a
 * clock that differs from the Worker's does not cut it short.
 */
function useShown(progress: ActionProgress) {
  const doneAt = progress.outcome.state === "done" ? progress.outcome.at : null;
  const [over, setOver] = useState<number | null>(null);
  useEffect(() => {
    if (doneAt === null) return;
    const timer = setTimeout(() => setOver(doneAt), DONE_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [doneAt]);
  return doneAt === null || over !== doneAt;
}

/**
 * K-538: the fill of the bar. Each step starts one compositor transition of `transform` from where the bar is to the
 * point where the step is expected to end, so nothing repaints while it moves. A client clock that differs from the
 * Worker's shifts the start of a step by that difference; revisit if clients show bars that jump.
 */
function Fill(props: { progress: ActionProgress }) {
  const ref = useRef<HTMLSpanElement>(null);
  const step = currentStep(props.progress);
  const startedAt = props.progress.steps[step]?.startedAt ?? null;
  const outcome = props.progress.outcome.state;
  const retrying = props.progress.retry !== null;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const bar = progressBar(props.progress, Date.now());
    element.style.transition = "none";
    element.style.transform = `scaleX(${bar.from})`;
    if (bar.ms === 0) return;
    // A layout read, so the start of the step is in place before its transition begins.
    void element.offsetWidth;
    element.style.transition = `transform ${bar.ms}ms linear`;
    element.style.transform = `scaleX(${bar.to})`;
  }, [step, startedAt, outcome, retrying]);
  return <span ref={ref} class="progress-fill" />;
}

/** K-538: the sticker of the action that runs on a card, a checkmark for a moment after it ended, or its failure. */
export function ProgressSticker(props: { progress: ActionProgress; panel: string }) {
  const { progress } = props;
  const shown = useShown(progress);
  if (!shown) return null;
  const tip = progressTip(progress);
  if (progress.outcome.state === "done")
    return (
      <span
        class="sticker ok state progress-done"
        role="img"
        aria-label={`${progress.action}: done`}
        data-tip={tip}
      >
        ✓
      </span>
    );
  const failed = progress.outcome.state === "failed";
  return (
    <a
      class={`sticker state action-progress ${failed ? "failed" : "wait"}`}
      href={props.panel}
      onPointerDown={keepPress}
      data-tip={tip}
    >
      {failed ? (
        "✗ failed"
      ) : progress.retry ? (
        "↻ retrying"
      ) : (
        <>
          <span class="progress-track">
            <Fill progress={progress} />
          </span>
          {currentStep(progress) + 1}/{progress.steps.length}
        </>
      )}
    </a>
  );
}

/** K-538: the steps of the card's action in its panel, for touch and keyboard, where a tooltip does not reach. */
export function ProgressRow(props: {
  cardId: string;
  progress: ActionProgress & { readonly canDismiss: boolean };
  /** The next steps after a failure, such as "Try again", next to Dismiss. */
  next?: ReadonlyArray<{ readonly label: string; readonly tip: string; readonly run: () => void }>;
  onToast: (text: string, error: boolean) => void;
}) {
  const { progress } = props;
  const index = currentStep(progress);
  const failed = progress.outcome.state === "failed";
  const dismiss = async () => {
    const answer = await callApi<object>(
      "POST",
      `/api/cards/${encodeURIComponent(props.cardId)}/progress/dismiss`,
    );
    if ("error" in answer) props.onToast(answer.error, true);
  };
  return (
    <div class="row progress-row">
      <span class="label" data-tip="The steps of the action that runs on this card, or that ended.">
        {progress.action}
      </span>
      {progress.outcome.state === "done" ? (
        <span class="stamp">✓ done</span>
      ) : failed ? (
        <span class="sticker action-progress failed">failed</span>
      ) : progress.retry ? (
        <span class="sticker wait">retrying</span>
      ) : (
        <span class="sticker wait">
          step {index + 1} of {progress.steps.length}
        </span>
      )}
      {progress.retry ? <span class="muted">{retryText(progress.retry)}</span> : null}
      <ol class="progress-steps">
        {progress.steps.map((step, at) => {
          const state =
            at < index
              ? "done"
              : at === index
                ? failed
                  ? "failed"
                  : progress.retry
                    ? "retrying"
                    : "running"
                : "next";
          return (
            <li key={step.label} class={state}>
              {state === "done"
                ? "✓"
                : state === "failed"
                  ? "✗"
                  : state === "retrying"
                    ? "↻"
                    : state === "running"
                      ? "→"
                      : "·"}{" "}
              {step.label}
              {state === "failed" && progress.outcome.state === "failed" ? (
                <p class="error">{progress.outcome.reason}</p>
              ) : null}
            </li>
          );
        })}
      </ol>
      {/* A failure after the last step has no step to stand under. */}
      {progress.outcome.state === "failed" && index >= progress.steps.length ? (
        <p class="error">{progress.outcome.reason}</p>
      ) : null}
      {failed
        ? props.next?.map((each) => (
            <button key={each.label} type="button" class="btn" data-tip={each.tip} onClick={each.run}>
              {each.label}
            </button>
          ))
        : null}
      {failed && progress.canDismiss ? (
        <button
          type="button"
          class="btn"
          data-tip="Take the failed action off the card. It changes nothing in Cloudflare or on the machine."
          onClick={() => void dismiss()}
        >
          Dismiss
        </button>
      ) : null}
    </div>
  );
}
