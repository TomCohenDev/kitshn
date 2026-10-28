import { useEffect, useState } from "preact/hooks";
import type { Resource } from "../core/model.ts";
import { callApi } from "./store.ts";

/** K-821: the text that every rollback dialog and tip shows, so nobody expects their data back or a secret to stay. */
export const ROLLBACK_DATA =
  "Data does not roll back. KV, Durable Objects, volumes and what the app wrote stay as they are. An older version can break on newer data. Secrets and vars go back to the values of that deploy. Rotate the secret again after a rollback if you rotated it after that deploy.";

interface Choice {
  readonly deployId: string;
  readonly sha: string;
  readonly at: number;
  readonly run: string | null;
  readonly note: string | null;
  readonly why: string | null;
}

interface Step {
  readonly card: string;
  readonly name: string;
  readonly deployId: string | null;
  readonly sha: string | null;
  readonly why: string | null;
}

/**
 * K-821: "Roll back…" of one card lists its last finished deploys, and "Roll back this run…" lists the cards of the
 * run that made its current deploy, in the order the rollback takes them.
 */
export function RollbackDialog(props: {
  card: Resource;
  mode: "card" | "run";
  onClose: () => void;
  onDone: (text: string, error: boolean) => void;
}) {
  const { card, mode } = props;
  const base = `/api/apps/${encodeURIComponent(card.id)}`;
  const [choices, setChoices] = useState<ReadonlyArray<Choice> | null>(null);
  const [steps, setSteps] = useState<ReadonlyArray<Step> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The dialog loads its list when it opens.
  useEffect(() => {
    if (mode === "card")
      void callApi<{ choices: Array<Choice> }>("GET", `${base}/rollbacks`).then((result) =>
        "error" in result ? setError(result.error) : setChoices(result.choices),
      );
    else
      void callApi<{ steps: Array<Step> }>("GET", `${base}/run-rollback`).then((result) =>
        "error" in result ? setError(result.error) : setSteps(result.steps),
      );
  }, [base, mode]);
  const act = async (call: () => Promise<{ text: string; error: boolean }>) => {
    if (busy) return;
    setBusy(true);
    const { text, error: failed } = await call();
    setBusy(false);
    props.onDone(text, failed);
    if (!failed) props.onClose();
  };
  const short = (sha: string | null) => (sha ?? "").slice(0, 7);
  const blocked = steps?.find((step) => step.why !== null) ?? null;
  return (
    <div class="scrim">
      <div
        class="dialog"
        role="dialog"
        aria-label={mode === "card" ? `Roll back ${card.name}` : `Roll back the run of ${card.name}`}
      >
        <div class="row">
          <b>{mode === "card" ? `Roll back ${card.name}` : `Roll back the run of ${card.name}`}</b>
        </div>
        <p class="help">{ROLLBACK_DATA}</p>
        {error ? <p class="error">{error}</p> : null}
        {mode === "card" && choices ? (
          <ul>
            {choices.map((choice, index) => (
              <li key={choice.deployId}>
                <div class="row">
                  <code>{short(choice.sha)}</code>{" "}
                  <span class="muted">
                    {new Date(choice.at).toLocaleString()}
                    {choice.run ? ` · run ${choice.run}` : ""}
                    {choice.note ? ` · ${choice.note}` : ""}
                  </span>
                  {index === 0 ? (
                    <span class="sticker" data-tip="This deploy serves now.">
                      serves now
                    </span>
                  ) : (
                    <button
                      type="button"
                      class="btn"
                      disabled={busy || choice.why !== null}
                      data-tip={choice.why ?? `Serve ${short(choice.sha)} again. ${ROLLBACK_DATA}`}
                      onClick={() =>
                        void act(async () => {
                          const result = await callApi<{ note: string }>("POST", `${base}/rollback`, {
                            deployId: choice.deployId,
                          });
                          return "error" in result
                            ? { text: result.error, error: true }
                            : { text: result.note, error: false };
                        })
                      }
                    >
                      Roll back to {short(choice.sha)}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {mode === "run" && steps ? (
          <>
            <ol>
              {steps.map((step) => (
                <li key={step.card}>
                  <div class="row">
                    <b>{step.name}</b>{" "}
                    {step.why ? (
                      <span class="muted">{step.why}</span>
                    ) : (
                      <code>back to {short(step.sha)}</code>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            <button
              type="button"
              class="btn danger"
              disabled={busy || blocked !== null || steps.length === 0}
              data-tip={
                blocked
                  ? `${blocked.name}: ${blocked.why}`
                  : `Roll back these cards in this order, and stop at the first that fails. ${ROLLBACK_DATA}`
              }
              onClick={() =>
                void act(async () => {
                  const result = await callApi<{ state: string; notes: Array<string> }>(
                    "POST",
                    `${base}/run-rollback`,
                  );
                  return "error" in result
                    ? { text: result.error, error: true }
                    : { text: result.notes.join(" "), error: result.state === "failed" };
                })
              }
            >
              Roll back {steps.length} {steps.length === 1 ? "card" : "cards"}
            </button>
          </>
        ) : null}
        <button type="button" class="btn" data-tip="Close without a rollback." onClick={props.onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
