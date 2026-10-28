import { useEffect, useState } from "preact/hooks";
import type { PauseMode, PauseReach } from "../core/model.ts";
import { Popover } from "./controls.tsx";

/** K-1504: the stored pause, as the button and the banner show it. */
export interface PauseView {
  readonly mode: PauseMode;
  readonly by: string | null;
  readonly at: number | null;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const when = (at: number) => new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const pausedLabel = (pause: PauseView) => (pause.mode === "lockdown" ? "Locked down" : "Paused");

/** The banner shrinks to a slim strip after this long, so it stops covering the map (K-1504). */
const BANNER_OPEN_MS = 6000;

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

/**
 * K-1504: the "i" of the big red button. It explains what one press does, and while paused who pressed it.
 * `reach` runs only while the card shows, so the counts cost nothing on other snapshots.
 */
function PauseInfo(props: {
  reach: () => PauseReach;
  pause: PauseView | null;
  anchor: HTMLElement;
  onClose: () => void;
}) {
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
          <h3>{props.pause ? pausedLabel(props.pause) : "What one press does"}</h3>
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
          {effects(props.reach(), props.pause).map((effect) => (
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
 * K-1504: the big red button, after the panic button of the machine map (MM-708): a red mushroom in a
 * hazard frame. One press pauses; while paused it stays down, and the "i" says why. The toolbar has the
 * compact one; the Safety section of the map panel has the big one, which only shows the paused state.
 */
export function PanicButton(props: {
  size: "toolbar" | "panel";
  reach: () => PauseReach;
  pause: PauseView | null;
  onPress: () => void;
}) {
  const [info, setInfo] = useState<HTMLElement | null>(null);
  const pause = props.pause;
  const hint = pause
    ? props.size === "panel" && pause.by
      ? `${pausedLabel(pause)} by ${pause.by}. Resume is in the toolbar and the banner.`
      : pausedLabel(pause)
    : "One press pauses all";
  return (
    <div class={`panic ${props.size}${pause ? " is-paused" : ""}`}>
      <div class="panic-inner">
        <div class="panic-well">
          <button
            type="button"
            class="mushroom"
            aria-label={pause ? "Emergency pause: paused" : "Emergency pause"}
            aria-disabled={pause ? true : undefined}
            data-tip={pause ? `${pausedLabel(pause)}. ${RESUME_TIP}` : PAUSE_TIP}
            onClick={() => {
              if (!pause) props.onPress();
            }}
          >
            {pause ? "off" : "stop"}
          </button>
        </div>
        <div class="panic-label">
          <b>Big red button</b>
          <span>{hint}</span>
        </div>
        <button
          type="button"
          class="panic-info"
          aria-label="What the big red button does"
          aria-expanded={info !== null}
          data-tip="What one press closes, stops and keeps, and how Resume works."
          onClick={(event) => setInfo(info ? null : event.currentTarget)}
        >
          i
        </button>
      </div>
      {info ? (
        <PauseInfo reach={props.reach} pause={pause} anchor={info} onClose={() => setInfo(null)} />
      ) : null}
    </div>
  );
}

/**
 * While paused: a hazard frame around the page and a banner with the kind of pause, who paused, when, and
 * Resume. It shrinks to a slim strip with "Paused" and Resume after a few seconds or on a click, and a click
 * on the strip opens it again.
 */
export function PausedBanner(props: {
  pause: PauseView;
  reach: PauseReach;
  besidePanel: boolean;
  onLockdown: () => void;
  onResume: () => void;
}) {
  const [shown, setShown] = useState<"auto" | "open" | "slim">("auto");
  useEffect(() => {
    const timer = setTimeout(() => setShown((now) => (now === "auto" ? "slim" : now)), BANNER_OPEN_MS);
    return () => clearTimeout(timer);
  }, []);
  const slim = shown === "slim";
  const lockdown = props.pause.mode === "lockdown";
  const resume = (
    <button type="button" class="btn resume" data-tip={RESUME_TIP} onClick={props.onResume}>
      Resume with passkey
    </button>
  );
  const sticker = (
    <span
      class="sticker paused-sticker"
      data-tip={
        lockdown ? "Lockdown: public sites are closed too." : "Emergency pause: public sites stay open."
      }
    >
      {lockdown ? "lockdown" : "emergency pause"}
    </span>
  );
  return (
    <>
      <div class="hazard-frame" aria-hidden="true" />
      <div class={`paused-place${props.besidePanel ? " beside-panel" : ""}`}>
        <section
          class={`paused-banner${slim ? " slim" : ""}`}
          role="status"
          onClick={(event) => {
            // A click on the banner, not on one of its buttons, opens or shrinks it.
            if ((event.target as Element).closest("button")) return;
            setShown(slim ? "open" : "slim");
          }}
        >
          <div class="hazard-strip" aria-hidden="true" />
          {slim ? (
            <div class="paused-strip">
              {sticker}
              <b>{lockdown ? "Locked down" : "Paused"}</b>
              <button
                type="button"
                class="btn"
                aria-expanded="false"
                data-tip="Show who paused, when, and what is closed."
                onClick={() => setShown("open")}
              >
                Details
              </button>
              {resume}
            </div>
          ) : (
            <div class="paused-body">
              <div class="paused-head">
                {sticker}
                <button
                  type="button"
                  class="btn"
                  aria-expanded="true"
                  aria-label="Shrink the banner"
                  data-tip="Shrink the banner to a slim strip, so it does not cover the map."
                  onClick={() => setShown("slim")}
                >
                  ▴
                </button>
              </div>
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
                {resume}
              </div>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
