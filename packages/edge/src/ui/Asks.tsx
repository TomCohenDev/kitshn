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
  /** K-1723: an approver circle that needs a passkey approves through the passkey path. */
  readonly needsPasskey: (id: string) => boolean;
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
              {proposal.machineName}: <code>{proposal.shown}</code>
              {proposal.reason ? <span class="muted"> · {proposal.reason}</span> : null}
              {Object.entries(proposal.labels).map(([key, value]) => (
                <span
                  key={key}
                  class="muted"
                  data-tip={
                    proposal.verified.includes(key)
                      ? "Verified: an attester of the machine set this label (K-1752)."
                      : "Claimed: the agent wrote this label; no attester checked it (K-1750)."
                  }
                >
                  {" "}
                  · {key}={value} ({proposal.verified.includes(key) ? "verified" : "claimed"})
                </span>
              ))}
            </span>
            <button
              type="button"
              disabled={busy.has(proposal.id)}
              data-tip="Approve: the login of the approver circle (a fresh passkey when it needs one), then you read the ask once more, then kitshn runs it."
              onClick={() =>
                location.assign(
                  `/api/approve/${props.needsPasskey(proposal.circleId) ? "passkey" : "login"}/start?approve=${encodeURIComponent(proposal.id)}&hash=${proposal.shownHash}`,
                )
              }
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

/**
 * K-1723: the id of an approval that the fresh passkey check sent back, and the hash of the text that the approver
 * read (K-1722), from `#approve/<id>/<hash>`.
 */
export function approveFromHash(hash: string): { readonly id: string; readonly seen: string } | null {
  if (!hash.startsWith("#approve/")) return null;
  const [id, seen] = hash.slice("#approve/".length).split("/");
  return id && seen ? { id: decodeURIComponent(id), seen } : null;
}

const OUTCOME_TEXT: Record<AskEventView["outcome"], string> = {
  done: "ran",
  waiting: "waits",
  refused: "refused",
  "not-kitshn": "not kitshn",
};

/** K-1717: the asks of agents as History events, newest first; they have no Undo. K-1756: a search by one label. */
export function AskEvents(props: { readonly events: ReadonlyArray<AskEventView> }) {
  const [label, setLabel] = useState("");
  const [found, setFound] = useState<ReadonlyArray<AskEventView> | null>(null);
  const search = async () => {
    if (!label.includes("=")) return setFound(null);
    const result = await callApi<{ events: ReadonlyArray<AskEventView> }>(
      "GET",
      `/api/ask-events?label=${encodeURIComponent(label)}`,
    );
    setFound("error" in result ? [] : result.events);
  };
  const events = found ?? props.events;
  if (props.events.length === 0) return null;
  return (
    <section class="ask-events">
      <h3
        class="label"
        data-tip="Asks of agents on machines: events, not changes, so they have no Undo (K-1717)."
      >
        Asks of agents
      </h3>
      <input
        aria-label="Search asks by label"
        placeholder="t3.thread.id=…"
        value={label}
        data-tip="A label as key=value, for example t3.thread.id=abc: the asks with it, newest first, at most 50."
        onInput={(event) => setLabel(event.currentTarget.value)}
        onKeyDown={(event) => event.key === "Enter" && void search()}
      />
      <ul class="repo-list">
        {events.map((event) => (
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
                <span
                  key={key}
                  class="muted"
                  data-tip={
                    event.verified.includes(key)
                      ? "Verified: an attester of the machine set this label (K-1752)."
                      : "Claimed: the agent wrote this label; no attester checked it (K-1750)."
                  }
                >
                  {" "}
                  · {key}={value} ({event.verified.includes(key) ? "verified" : "claimed"})
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
