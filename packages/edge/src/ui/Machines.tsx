import { useState } from "preact/hooks";
import type { Command } from "../core/machine.ts";
import type { JobView, MachineView } from "../core/protocol.ts";
import { callApi } from "./store.ts";

/** "5 min", "3 h", "2 d": how long ago a time was (K-515). */
export function ago(time: number | null, now = Date.now()): string {
  if (time === null) return "never";
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

const percent = (value: number | undefined) => (value === undefined ? "–" : `${Math.round(value * 100)}%`);

/** K-515: the presence sticker of a machine card. */
export function PresenceSticker(props: { view: MachineView }) {
  return props.view.online ? (
    <span class="sticker ok presence">online</span>
  ) : (
    <span class="sticker presence" title="Last seen">
      offline · {ago(props.view.lastSeen)}
    </span>
  );
}

/** K-602: "Add machine" makes a service token, a tunnel and a join code that works once for 10 minutes. */
export function AddMachine(props: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [labels, setLabels] = useState("");
  const [result, setResult] = useState<{ command: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div class="scrim" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <div class="dialog" role="dialog" aria-label="Add machine">
        <h2>Add machine</h2>
        {result ? (
          <>
            <p>
              Run this on the machine, as the user that runs the daemon. It works once, until{" "}
              {new Date(result.expiresAt).toLocaleTimeString()}.
            </p>
            <pre class="command">{result.command}</pre>
            <div class="row">
              <button class="btn primary" onClick={() => void navigator.clipboard.writeText(result.command)}>
                Copy
              </button>
              <button class="btn" onClick={props.onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const response = await callApi<{ command: string; expiresAt: number }>(
                "POST",
                "/api/machines",
                {
                  name,
                  labels: labels
                    .split(",")
                    .map((label) => label.trim())
                    .filter(Boolean),
                },
              );
              if ("error" in response) setError(response.error);
              else setResult(response);
            }}
          >
            <p class="muted">
              The new machine card starts in the tray, so it is private until you place it (K-509).
            </p>
            <input
              placeholder="Name, for example Oracle VPS"
              value={name}
              onInput={(event) => setName((event.target as HTMLInputElement).value)}
            />
            <input
              placeholder="Labels, for example docker, server, arm"
              value={labels}
              onInput={(event) => setLabels((event.target as HTMLInputElement).value)}
            />
            <div class="row">
              <button class="btn primary">Make a join code</button>
              <button class="btn" type="button" onClick={props.onClose}>
                Cancel
              </button>
            </div>
            {error ? <p class="muted">{error}</p> : null}
          </form>
        )}
      </div>
    </div>
  );
}

const describe = (command: Command) =>
  command.kind === "shell"
    ? command.script
    : command.kind === "update"
      ? `update to ${command.version}`
      : command.kind;

/** The machine part of the card panel: status, sample, commands (K-612) and removal (K-615). */
export function MachinePanel(props: {
  view: MachineView;
  /** K-617: the release of this kitshn. */
  version: string;
  jobs: ReadonlyArray<JobView>;
  onRemove: () => void;
  onToast: (text: string, error: boolean) => void;
}) {
  const { view } = props;
  const [script, setScript] = useState("");
  const run = async (command: Command) => {
    const result = await callApi<{ id: number }>("POST", "/api/jobs", {
      machineId: view.machine.id,
      command,
    });
    if ("error" in result) props.onToast(result.error, true);
    else props.onToast(`Job #${result.id} is queued.`, false);
  };
  const jobs = props.jobs.filter((job) => job.machineId === view.machine.id);
  return (
    <>
      <div class="row">
        <PresenceSticker view={view} />
        {view.status ? (
          <span class="muted">
            {view.status.hostname} · {view.status.os} · {view.status.arch} · kitshn {view.status.version} ·
            tunnel {view.status.tunnel}
          </span>
        ) : null}
      </div>
      {view.sample ? (
        <div class="row">
          <span class="label">CPU</span> {percent(view.sample.cpu)} <span class="label">Memory</span>{" "}
          {percent(view.sample.memory)} <span class="label">Disk</span> {percent(view.sample.disk)}
        </div>
      ) : null}
      <form
        class="row"
        onSubmit={async (event) => {
          event.preventDefault();
          const input = (event.currentTarget as HTMLFormElement).elements.namedItem(
            "labels",
          ) as HTMLInputElement;
          const result = await callApi<{ id: string }>(
            "POST",
            `/api/machines/${encodeURIComponent(view.machine.id)}`,
            {
              labels: input.value
                .split(",")
                .map((label) => label.trim())
                .filter(Boolean),
            },
          );
          props.onToast("error" in result ? String(result.error) : "Saved the labels.", "error" in result);
        }}
      >
        <span class="label">Labels</span>
        <input
          name="labels"
          key={view.machine.labels.join(",")}
          defaultValue={view.machine.labels.join(", ")}
          placeholder="docker, server"
        />
        <button class="btn">Save</button>
      </form>
      <div class="label" style={{ marginTop: "10px" }}>
        Commands
      </div>
      <form
        class="row"
        onSubmit={(event) => {
          event.preventDefault();
          if (script.trim()) void run({ kind: "shell", script }).then(() => setScript(""));
        }}
      >
        <input
          class="mono"
          placeholder="Shell command, needs control"
          value={script}
          onInput={(event) => setScript((event.target as HTMLInputElement).value)}
        />
        <button class="btn">Run</button>
      </form>
      <div class="row">
        <button class="btn" onClick={() => void run({ kind: "diagnostics" })}>
          Diagnostics
        </button>
        <button class="btn" onClick={() => void run({ kind: "restart" })}>
          Restart daemon
        </button>
        <button
          class={`btn${view.status && view.status.version !== props.version ? " primary" : ""}`}
          title={`Install the daemon of release ${props.version}`}
          onClick={() => void run({ kind: "update", version: props.version })}
        >
          {view.status && view.status.version !== props.version
            ? `Update daemon to ${props.version}`
            : "Update daemon"}
        </button>
      </div>
      <ul>
        {jobs.slice(0, 5).map((job) => (
          <li key={job.id}>
            <div class="row">
              <code>#{job.id}</code> <code>{describe(job.command)}</code>
              <span
                class={`sticker ${job.state === "done" ? "ok" : job.state === "queued" || job.state === "sent" ? "wait" : ""}`}
              >
                {job.state}
              </span>
            </div>
            {job.output ? <pre class="output">{job.output}</pre> : null}
          </li>
        ))}
      </ul>
      <button class="btn danger" onClick={props.onRemove}>
        Remove machine
      </button>
    </>
  );
}

/** K-519: the Machines view, a table of status and health. */
export function MachinesView(props: { machines: ReadonlyArray<MachineView>; onAdd: () => void }) {
  return (
    <section class="history">
      <h2>Machines</h2>
      <p class="muted">
        Each machine runs the kitshn daemon. Commands and jobs need control on the machine card.
      </p>
      <button class="btn primary" onClick={props.onAdd}>
        + Machine
      </button>
      <table>
        <thead>
          <tr>
            <th>Machine</th>
            <th>Status</th>
            <th>Labels</th>
            <th>CPU</th>
            <th>Memory</th>
            <th>Disk</th>
            <th>Daemon</th>
          </tr>
        </thead>
        <tbody>
          {props.machines.map((view) => (
            <tr key={view.machine.id}>
              <td>
                <a href={`#map/${view.machine.id}`}>{view.machine.name}</a>
              </td>
              <td>
                <PresenceSticker view={view} />
              </td>
              <td>{view.machine.labels.join(", ")}</td>
              <td>{percent(view.sample?.cpu)}</td>
              <td>{percent(view.sample?.memory)}</td>
              <td>{percent(view.sample?.disk)}</td>
              <td>{view.status ? `${view.status.version} · ${view.status.arch}` : "–"}</td>
            </tr>
          ))}
          {props.machines.length === 0 ? (
            <tr>
              <td colSpan={7}>No machine yet. Add one; the command joins it in one step.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}
