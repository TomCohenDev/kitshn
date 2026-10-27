/** K-1504: what one press of the emergency pause stops, in the order the owner reads it. */
const STOPS = [
  "Every share closes, except the Owner circle's people on the kitshn admin: sites, Compose apps, live sites, pages and files, public ones too.",
  "Devices, agent keys and machines lose every share, so agent keys stop moving, deploying and running jobs.",
  "New deploys from GitHub wait until Resume.",
  "Agents in T3 Code get “stop all agents” once the T3 provider is on (milestone 5).",
] as const;

/** The confirm of the big red button: one press after this pauses at once. */
export function PauseDialog(props: { onCancel: () => void; onPause: () => void }) {
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
        <p class="help">
          Machines stay connected and their apps keep running behind closed doors. You keep the admin. Resume needs
          your passkey again.
        </p>
        <div class="row">
          <button type="button" class="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" class="btn big-red" autoFocus onClick={props.onPause}>
            Pause everything
          </button>
        </div>
      </div>
    </div>
  );
}

/** While paused: a hazard frame around the page and a banner with who paused, when, and Resume. */
export function PausedBanner(props: { by: string | null; since: string | null; onResume: () => void }) {
  return (
    <>
      <div class="hazard-frame" aria-hidden="true" />
      <div class="paused-banner" role="status">
        <strong>Everything is paused</strong>
        {props.by ? (
          <span>
            by {props.by}
            {props.since ? ` · ${props.since}` : ""}
          </span>
        ) : null}
        <button type="button" class="btn" onClick={props.onResume}>
          Resume with passkey
        </button>
      </div>
    </>
  );
}
