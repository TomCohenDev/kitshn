import { useState } from "preact/hooks";
import type { PauseMode, PauseReach } from "../core/model.ts";
import { Popover } from "./controls.tsx";
import type { Rect } from "./popover.ts";

/** K-1504: the stored pause, as the button and the banner show it. */
export interface PauseView {
  readonly mode: PauseMode;
  readonly by: string | null;
  readonly at: number | null;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const when = (at: number) => new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

export const PAUSE_TIP =
  "Emergency pause: one press closes every share except your admin, and stops agent keys and new deploys. Public sites stay up. Resume needs your passkey.";
export const RESUME_TIP = "Resume: confirm with your passkey again, and every share comes back.";
export const LOCKDOWN_TIP =
  "Make the pause a lockdown: public sites, apps, pages and files close too. Only Resume opens them again.";

/** K-1504 in plain words, with the counts of the map now. Keep it true to the spec and to `activeShares`. */
function effects(reach: PauseReach, pause: PauseView | null) {
  const paused = pause !== null;
  const lockdown = pause?.mode === "lockdown";
  const shares = `${plural(reach.closes, "share")} on ${plural(reach.cards, "card")}`;
  const publicShares = plural(reach.keptPublic, "public share");
  return [
    {
      label: "close",
      tone: "cut",
      text: `${paused ? "Closed" : "Closes"} ${shares}: every share that is not public, except your admin. Public machines and repos close too.`,
    },
    {
      label: "stop",
      tone: "cut",
      text: "Devices, agent keys and machines lose every share. Agent keys stop moving, deploying and running jobs, and the jobs they queued fail. T3 agents get “stop all agents” once the T3 provider is on.",
    },
    {
      label: "wait",
      tone: "wait",
      text: "New deploys from GitHub wait until Resume. A deploy that runs now finishes behind closed doors.",
    },
    {
      label: "freeze",
      tone: "info",
      text: "kitshn refuses every change that raises access. Lowering access still works.",
    },
    {
      label: "keep",
      tone: "ok",
      text: `${
        lockdown
          ? `Lockdown: closed ${publicShares} of sites, apps, pages and files too.`
          : `Keeps ${publicShares} of sites, apps, pages and files open, unless you close public sites too.`
      } You keep the admin. Machines stay connected, and their apps keep running behind closed doors.`,
    },
  ] as const;
}

/** K-1504: the "i" of the big red button. It explains what one press does, and while paused who pressed it. */
function PauseInfo(props: { reach: PauseReach; pause: PauseView | null; anchor: Rect; onClose: () => void }) {
  const title = props.pause
    ? props.pause.mode === "lockdown"
      ? "Locked down"
      : "Paused"
    : "What one press does";
  return (
    <Popover
      label="What the big red button does"
      anchor={props.anchor}
      onClose={props.onClose}
      class="pause-info"
    >
      <div class="hazard-strip" aria-hidden="true" />
      <div class="pause-info-body">
        <div class="pause-info-head">
          <h3>{title}</h3>
          <button
            type="button"
            class="btn"
            aria-label="Close"
            data-tip="Close this explanation."
            onClick={props.onClose}
          >
            ×
          </button>
        </div>
        {props.pause?.by ? (
          <p class="pause-info-now">
            {props.pause.by} pressed it{props.pause.at === null ? "" : ` on ${when(props.pause.at)}`}.
          </p>
        ) : props.pause ? null : (
          <p class="pause-info-now">No confirm: it stops all of this at once.</p>
        )}
        <ul class="pause-info-effects">
          {effects(props.reach, props.pause).map((effect) => (
            <li key={effect.label}>
              <span class={`sticker ${effect.tone}`}>{effect.label}</span>
              <span>{effect.text}</span>
            </li>
          ))}
        </ul>
        <p class="pause-info-resume">
          <b>Resume</b> needs your passkey again and returns every share. An edit or an undo never resumes.
        </p>
      </div>
    </Popover>
  );
}

/**
 * K-1504: the big red button of the toolbar, after the panic button of the machine map (MM-708): a red
 * mushroom in a hazard frame. One press pauses; while paused it stays down, and the "i" says why.
 */
export function PanicButton(props: { reach: PauseReach; pause: PauseView | null; onPress: () => void }) {
  const [info, setInfo] = useState<Rect | null>(null);
  const paused = props.pause !== null;
  return (
    <div class={`panic${paused ? " is-paused" : ""}`}>
      <div class="panic-inner">
        <div class="panic-well">
          <button
            type="button"
            class="mushroom"
            aria-label={paused ? "Emergency pause: paused" : "Emergency pause"}
            aria-disabled={paused || undefined}
            data-tip={paused ? `Paused. ${RESUME_TIP}` : PAUSE_TIP}
            onClick={() => {
              if (!paused) props.onPress();
            }}
          >
            {paused ? "off" : "stop"}
          </button>
        </div>
        <div class="panic-label">
          <b>Big red button</b>
          <span>
            {paused ? (props.pause?.mode === "lockdown" ? "Locked down" : "Paused") : "One press pauses all"}
          </span>
        </div>
        <button
          type="button"
          class="panic-info"
          aria-label="What the big red button does"
          aria-expanded={info !== null}
          data-tip="What one press closes, stops and keeps, and how Resume works."
          onClick={(event) => setInfo(info ? null : event.currentTarget.getBoundingClientRect())}
        >
          i
        </button>
      </div>
      {info ? (
        <PauseInfo reach={props.reach} pause={props.pause} anchor={info} onClose={() => setInfo(null)} />
      ) : null}
    </div>
  );
}

/** While paused: a hazard frame around the page and a banner with the kind of pause, who paused, when, and Resume. */
export function PausedBanner(props: {
  pause: PauseView;
  reach: PauseReach;
  besidePanel: boolean;
  onLockdown: () => void;
  onResume: () => void;
}) {
  const lockdown = props.pause.mode === "lockdown";
  return (
    <>
      <div class="hazard-frame" aria-hidden="true" />
      <div class={`paused-place${props.besidePanel ? " beside-panel" : ""}`}>
        <section class="paused-banner" role="status">
          <div class="hazard-strip" aria-hidden="true" />
          <div class="paused-body">
            <span
              class="sticker paused-sticker"
              data-tip={
                lockdown
                  ? "Lockdown: public sites are closed too."
                  : "Emergency pause: public sites stay open."
              }
            >
              {lockdown ? "lockdown" : "emergency pause"}
            </span>
            <h2>{lockdown ? "Everything is locked down" : "Everything is paused"}</h2>
            <p>
              {props.pause.by ?? "Someone"} pressed the big red button
              {props.pause.at === null ? "" : ` on ${when(props.pause.at)}`}. Closed:{" "}
              {plural(props.reach.closes, "share")} on {plural(props.reach.cards, "card")}. Agent keys and
              machines have no shares, and new deploys wait.{" "}
              {lockdown
                ? "Public sites, apps, pages and files are closed too."
                : `Still open: ${plural(props.reach.keptPublic, "public share")} of sites, apps, pages and files.`}
            </p>
            <div class="row">
              {lockdown ? null : (
                <button type="button" class="btn danger" data-tip={LOCKDOWN_TIP} onClick={props.onLockdown}>
                  Close public sites too
                </button>
              )}
              <button type="button" class="btn resume" data-tip={RESUME_TIP} onClick={props.onResume}>
                Resume with passkey
              </button>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
