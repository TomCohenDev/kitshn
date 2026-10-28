import { useState } from "preact/hooks";
import type { PauseMode } from "../core/model.ts";
import { Switch } from "./controls.tsx";
/** K-1504: what one press of the emergency pause stops, in the order the owner reads it. */
const STOPS = [
  "Every share that is not public closes, except the Owner circle's people on the kitshn admin: sites, Compose apps, live sites, pages and files. Public shares of machines and repos close too.",
  "Devices, agent keys and machines lose every share, so agent keys stop moving, deploying and running jobs.",
  "New deploys from GitHub wait until Resume.",
  "Agents in T3 Code get “stop all agents” once the T3 provider is on.",
] as const;

/** The confirm of the big red button: one press after this pauses at once. */
export function PauseDialog(props: { onCancel: () => void; onPause: (mode: PauseMode) => void }) {
  const [lockdown, setLockdown] = useState(false);
  return (
    <div class="scrim" onClick={(event) => event.target === event.currentTarget && props.onCancel()}>
      <div class="card dialog pause-dialog" role="alertdialog" aria-labelledby="pause-title">
        <h2 id="pause-title">Emergency pause</h2>
        <p>One press stops all of this at once:</p>
        <ul>
          {STOPS.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <Switch
          checked={lockdown}
          label="Also close public sites"
          tip="Also close public sites: a lockdown, which also closes the public shares of sites, apps, pages and files."
          onChange={setLockdown}
        />
        <p class="help">
          {lockdown
            ? "Lockdown: public sites, apps, pages and files close too."
            : "Public sites, apps, pages and files of public circles stay open."}{" "}
          Machines stay connected and their apps keep running behind closed doors. You keep the admin. Resume needs
          your passkey again.
        </p>
        <div class="row">
          <button type="button" class="btn" data-tip="Cancel: nothing stops." onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            class="btn big-red"
            data-tip={
              lockdown
                ? "Lock down: stop all of the above, and close public sites, apps, pages and files too. Pages and files close at once; Access closes over a few alarm runs."
                : "Pause: stop all of the above. Public sites, apps and pages stay up. Pages and files close at once; Access closes over a few alarm runs."
            }
            autoFocus onClick={() => props.onPause(lockdown ? "lockdown" : "keep-public")}>
            {lockdown ? "Lock down everything" : "Pause"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** While paused: a hazard frame around the page and a banner with the kind of pause, who paused, when, and Resume. */
export function PausedBanner(props: {
  mode: PauseMode;
  by: string | null;
  since: string | null;
  onLockdown: () => void;
  onResume: () => void;
}) {
  return (
    <>
      <div class="hazard-frame" aria-hidden="true" />
      <div class="paused-banner" role="status">
        <strong>{props.mode === "lockdown" ? "Lockdown" : "Paused, public sites open"}</strong>
        {props.by ? (
          <span>
            by {props.by}
            {props.since ? ` · ${props.since}` : ""}
          </span>
        ) : null}
        {props.mode === "keep-public" ? (
          <button
            type="button"
            class="btn danger"
            data-tip="Make the pause a lockdown: public sites, apps, pages and files close too. Only Resume opens them again."
            onClick={props.onLockdown}
          >
            Close public sites too
          </button>
        ) : null}
        <button
          type="button"
          class="btn"
          data-tip="Resume: confirm with your passkey again, and every share comes back."
          onClick={props.onResume}
        >
          Resume with passkey
        </button>
      </div>
    </>
  );
}
