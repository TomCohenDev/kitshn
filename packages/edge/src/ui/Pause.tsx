import { useEffect, useState } from "preact/hooks";
import type { PauseMode, PauseReach } from "../core/model.ts";
import { lidSound } from "./panic.ts";

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

/** K-1504: the toolbar opener of the big red button. It never pauses; it opens the Safety panel. */
export function PanicOpener(props: { pause: PauseView | null; open: boolean; onOpen: () => void }) {
  const pause = props.pause;
  return (
    <button
      type="button"
      class={`panic opener${pause ? " is-paused" : ""}`}
      aria-expanded={props.open}
      data-tip={
        pause
          ? `${pausedLabel(pause)}. Open the big red button to see what is closed. ${RESUME_TIP}`
          : "Open the big red button: lift its lid, then press to pause everything at once."
      }
      onClick={props.onOpen}
    >
      <span class="panic-inner">
        <span class="panic-well" aria-hidden="true">
          <span class="mushroom">{pause ? "off" : "stop"}</span>
        </span>
        <span class="panic-label">
          <b>Big red button</b>
          <span>{pause ? pausedLabel(pause) : "Lift the lid, press"}</span>
        </span>
      </span>
    </button>
  );
}

/**
 * K-1504: the big red button in the Safety panel, after the panic button of the machine map (MM-708): a red
 * mushroom under a flip-up lid in a hazard frame. Lifting the lid is part of the button, not a confirm; one
 * press then pauses. While paused it stays down. Below it, what one press does, with the counts of the map.
 */
export function SafetyView(props: {
  reach: () => PauseReach;
  pause: PauseView | null;
  onPress: () => void;
  onLockdown: () => void;
}) {
  const [lifted, setLifted] = useState(false);
  const pause = props.pause;
  // A pause or a resume, also from another device, closes the lid, so a resume never leaves it lifted.
  const pauseKey = pause === null ? null : `${pause.mode}:${pause.at ?? ""}`;
  const [seenPause, setSeenPause] = useState(pauseKey);
  if (seenPause !== pauseKey) {
    setSeenPause(pauseKey);
    setLifted(false);
  }
  const hint = pause
    ? `${pausedLabel(pause)}. Resume is in the toolbar and the banner.`
    : lifted
      ? "Press to stop everything"
      : "Lift the lid first";
  return (
    <div class="safety">
      <div class={`panic panel${pause ? " is-paused" : ""}`}>
        <span class="sticker panic-note" aria-hidden="true">
          hands off
        </span>
        <div class="panic-inner">
          <div class="panic-well">
            {pause ? null : (
              <button
                type="button"
                class={`lid${lifted ? " open" : ""}`}
                aria-expanded={lifted}
                aria-label={lifted ? "Close the lid" : "Lift the lid"}
                data-tip={lifted ? "Close the lid." : "Lift the lid to reach the big red button."}
                onClick={() => {
                  lidSound(!lifted);
                  setLifted(!lifted);
                }}
              >
                <span>{lifted ? "close" : "lift"}</span>
              </button>
            )}
            <button
              type="button"
              class="mushroom"
              aria-label={pause ? "Emergency pause: paused" : "Emergency pause"}
              aria-disabled={pause || !lifted ? true : undefined}
              data-tip={pause ? `${pausedLabel(pause)}. ${RESUME_TIP}` : lifted ? PAUSE_TIP : "Lift the lid first."}
              onClick={() => {
                if (pause || !lifted) return;
                setLifted(false);
                props.onPress();
              }}
            >
              {pause ? "off" : "stop"}
            </button>
          </div>
          <div class="panic-label">
            <b>Big red button</b>
            <span>{hint}</span>
          </div>
        </div>
      </div>
      <h3 class="safety-head">{pause ? pausedLabel(pause) : "What one press does"}</h3>
      {pause?.by ? (
        <p class="pause-info-now">
          {pause.by} pressed it{pause.at === null ? "" : ` on ${when(pause.at)}`}.
        </p>
      ) : pause ? null : (
        <p class="pause-info-now">No confirm after the lid: one press stops all of this at once.</p>
      )}
      <ul class="pause-info-effects">
        {effects(props.reach(), pause).map((effect) => (
          <li key={effect.label}>
            <span class={`sticker ${effect.tone}`}>{effect.label}</span>
            <span>{effect.text}</span>
          </li>
        ))}
      </ul>
      {pause?.mode === "keep-public" ? (
        <div class="row">
          <button type="button" class="btn danger" data-tip={LOCKDOWN_TIP} onClick={props.onLockdown}>
            Close public sites too
          </button>
        </div>
      ) : null}
      <p class="pause-info-resume">
        <b>Resume</b> needs your passkey again and returns every share. An edit or an undo never resumes.
      </p>
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
          // A hand or the focus on the open banner keeps it open; the shrink waits only on an idle banner.
          onPointerEnter={() => setShown((now) => (now === "auto" ? "open" : now))}
          onFocusIn={() => setShown((now) => (now === "auto" ? "open" : now))}
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
