import { useState } from "preact/hooks";
import { MACHINE_RIGHT_NAMES } from "../core/model.ts";
import type { AskEventView, ProposalView } from "../core/protocol.ts";
import { callApi } from "./store.ts";

/**
 * K-1722: the asks that wait for an approver circle. One small component: the notifications work folds it into its
 * Inbox later, and the proposals of the snapshot stay the source of truth.
 */
export function AskList(props: {
  readonly proposals: ReadonlyArray<ProposalView>;
  readonly circleName: (id: string) => string;
  readonly onToast: (text: string, error: boolean) => void;
}) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  if (props.proposals.length === 0) return null;
  const deny = async (proposal: ProposalView) => {
    setBusy((ids) => new Set(ids).add(proposal.id));
    try {
      const result = await callApi<{ result: unknown }>(
        "POST",
        `/api/proposals/${encodeURIComponent(proposal.id)}/deny`,
        {},
      );
      props.onToast(
        "error" in result ? result.error : `Denied the ask of ${proposal.machineName}.`,
        "error" in result,
      );
    } finally {
      setBusy((ids) => {
        const next = new Set(ids);
        next.delete(proposal.id);
        return next;
      });
    }
  };
  return (
    <>
      <div
        class="label"
        data-tip="Asks: agents on machines wait for one member of the approver circle (K-1722)."
      >
        Asks
      </div>
      <ul class="repo-list">
        {props.proposals.map((proposal) => (
          <li key={proposal.id}>
            <span class="sticker wait" data-tip={`It waits for ${props.circleName(proposal.circleId)}.`}>
              {MACHINE_RIGHT_NAMES[proposal.right]}
            </span>
            <span class="name">
              {proposal.machineName}: <code>{`${proposal.action} ${proposal.target}`.trim()}</code>
              {proposal.reason ? <span class="muted"> · {proposal.reason}</span> : null}
              {Object.entries(proposal.labels).map(([key, value]) => (
                <span
                  key={key}
                  class="muted"
                  data-tip="A label that the agent wrote; no attester checked it."
                >
                  {" "}
                  · {key}={value} (claimed)
                </span>
              ))}
            </span>
            <button
              type="button"
              disabled={busy.has(proposal.id)}
              data-tip="Approve: a fresh passkey check, then kitshn runs the ask."
              onClick={() => location.assign(`/api/fresh/start?approve=${encodeURIComponent(proposal.id)}`)}
            >
              Approve
            </button>
            <button
              type="button"
              disabled={busy.has(proposal.id)}
              data-tip="Deny: the agent hears that you denied it."
              onClick={() => void deny(proposal)}
            >
              Deny
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** K-1723: the id of an approval that the fresh passkey check sent back, from `#approve/<id>`. */
export const approveFromHash = (hash: string) =>
  hash.startsWith("#approve/") ? decodeURIComponent(hash.slice("#approve/".length)) : null;

const OUTCOME_TEXT: Record<AskEventView["outcome"], string> = {
  done: "ran",
  waiting: "waits",
  refused: "refused",
};

/** K-1717: the asks of agents as History events, newest first; they have no Undo. */
export function AskEvents(props: { readonly events: ReadonlyArray<AskEventView> }) {
  if (props.events.length === 0) return null;
  return (
    <section class="ask-events">
      <h3
        class="label"
        data-tip="Asks of agents on machines: events, not changes, so they have no Undo (K-1717)."
      >
        Asks of agents
      </h3>
      <ul class="repo-list">
        {props.events.map((event) => (
          <li key={event.id}>
            <span class="muted">
              {new Date(event.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
            </span>
            <span class="name">
              {event.machineName}: <code>{`${event.action} ${event.target}`.trim()}</code>{" "}
              {OUTCOME_TEXT[event.outcome]}
              {event.outcome === "refused" ? <span class="muted"> · {event.detail}</span> : null}
              {event.reason ? <span class="muted"> · {event.reason}</span> : null}
              {Object.entries(event.labels).map(([key, value]) => (
                <span key={key} class="muted">
                  {" "}
                  · {key}={value}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
