import { useState } from "preact/hooks";
import type { Command } from "../core/machine.ts";
import type { JobView, MachineView } from "../core/protocol.ts";
import { MACHINE_TIPS, isRelease } from "./actions.ts";
import { callApi, useStore } from "./store.ts";

/** "5 min", "3 h", "2 d": how long ago a time was (K-515). */
export function ago(time: number | null, now = Date.now()): string {
  if (time === null) return "never";
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

const JOB_TIPS: Record<JobView["state"], string> = {
  queued: "Queued: the job waits for the machine.",
  sent: "Sent: the machine has the job and runs it.",
  done: "Done: the job ended well.",
  failed: "Failed: the job ended with an error; the output says why.",
  expired: "Expired: the machine did not take the job before its expiry.",
};

const percent = (value: number | undefined) => (value === undefined ? "–" : `${Math.round(value * 100)}%`);

/** K-515: the presence sticker of a machine card. */
/** `time` off on a machine card: its live row says "seen … ago", and the shorter sticker keeps the foot on one line (K-515). */
export function PresenceSticker(props: { view: MachineView; time?: boolean }) {
  return props.view.online ? (
    <span class="sticker ok presence" data-tip="Online: the daemon has a connection to kitshn now.">
      online
    </span>
  ) : (
    <span class="sticker presence" data-tip="Offline: the time since kitshn last heard from the daemon.">
      {props.time === false ? "offline" : `offline · ${ago(props.view.lastSeen)}`}
    </span>
  );
}

/**
 * K-515, K-1616: the live rows of a machine card, at a fixed height, so the card never grows over its neighbour when
 * the machine comes online or a sticker appears: the daemon line, CPU and memory bars from the newest sample (K-605),
 * and the stickers of its state. Offline, the bar row stays empty, because an old load is wrong.
 */
export function MachineLive(props: { view: MachineView }) {
  const { online, status, sample, lastSeen } = props.view;
  const daemon = status ? `daemon ${status.version} · ${status.os} ${status.arch}` : "no status yet";
  return (
    <div class="live">
      <div class="sub">{online ? daemon : `seen ${ago(lastSeen)} ago · ${daemon}`}</div>
      <div class="meters">
        {online && sample ? (
          <>
            <Meter label="CPU" value={sample.cpu} />
            <Meter label="Mem" value={sample.memory} />
          </>
        ) : null}
      </div>
      <div class="live-stickers">
        <MachineStickers view={props.view} />
      </div>
    </div>
  );
}

function Meter(props: { label: string; value: number }) {
  const share = Math.min(1, Math.max(0, props.value));
  return (
    <span
      class="meter"
      role="img"
      aria-label={`${props.label} ${percent(share)}`}
      data-tip={`${props.label} ${percent(share)} at the last sample, once a minute (K-605).`}
    >
      <span class="meter-label">{props.label}</span>
      <span class="meter-bar">
        <span class={share >= 0.9 ? "hot" : ""} style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
      <span class="meter-value">{percent(share)}</span>
    </span>
  );
}

/** The card starts a drag on a press; a link on it opens instead. */
const keepPress = (event: PointerEvent) => event.stopPropagation();

/**
 * K-515, K-1616, K-1902: the asks that the viewer may answer, the jobs that wait, and the daemon against the release
 * of the Worker. The ask comes first, so it stays in view on a narrow card. Each is a link where it acts: the version
 * to the panel with "Update daemon" (K-612).
 */
function MachineStickers(props: { view: MachineView }) {
  const { snapshot } = useStore();
  if (!snapshot) return null;
  const { machine, online, status } = props.view;
  const queued = snapshot.queuedJobs[machine.id] ?? 0;
  // The snapshot holds only the asks that this viewer may answer (K-1902).
  const asks = snapshot.proposals.filter((proposal) => proposal.machineId === machine.id).length;
  const panel = `#map/${encodeURIComponent(machine.id)}`;
  const version =
    !online || !status || !isRelease(snapshot.version) ? null : !isRelease(status.version) ? (
      <span
        class="sticker info"
        tabIndex={0}
        data-tip={`From source: this daemon runs ${status.version}, not a release, so Update daemon refuses it. Pull its checkout and restart it.`}
      >
        source
      </span>
    ) : status.version === snapshot.version ? (
      <a
        class="sticker ok"
        href={panel}
        onPointerDown={keepPress}
        data-tip={`Newest: the daemon runs edge-${snapshot.version}, the release of the Worker (K-617). Its panel has Update daemon.`}
      >
        newest
      </a>
    ) : (
      <a
        class="sticker wait"
        href={panel}
        onPointerDown={keepPress}
        data-tip={`Behind: the daemon runs edge-${status.version}, the Worker runs edge-${snapshot.version}. Update daemon in its panel installs it (K-612).`}
      >
        behind
      </a>
    );
  return (
    <>
      {asks > 0 ? (
        <a
          class="sticker wait"
          href={`#notifications/${encodeURIComponent(machine.id)}`}
          onPointerDown={keepPress}
          data-tip={`An agent on ${machine.name} waits for your answer. The Inbox shows ${asks === 1 ? "its ask" : `its ${asks} asks`}.`}
        >
          {asks} needs you
        </a>
      ) : null}
      {queued > 0 ? (
        <a
          class="sticker info"
          href="#machines"
          onPointerDown={keepPress}
          data-tip={`${queued} ${queued === 1 ? "job waits" : "jobs wait"} for this machine. The Machines view lists them.`}
        >
          {queued} queued
        </a>
      ) : null}
      {version}
    </>
  );
}

/** K-1708: a machine without a key, or one that waits for `kitshn rekey` (K-1706), shows it on its card. */
export function KeySticker(props: { view: MachineView }) {
  const key = props.view.machine.key;
  if (key === undefined)
    return (
      <span
        class="sticker wait"
        data-tip="Needs a key: it reports status but gets no job until kitshn rekey runs on it."
      >
        needs a key
      </span>
    );
  if (key.kind === "waiting")
    return (
      <span class="sticker wait" data-tip="Waits for key: run the rekey command on the machine.">
        waits for key
      </span>
    );
  return null;
}

/** K-1608: the pushes of state that an offline machine gets when it connects. */
export function QueuedSticker(props: { view: MachineView }) {
  if (props.view.queued === 0) return null;
  return (
    <span
      class="sticker wait"
      data-tip={`Queued: ${props.view.queued} changes of grants, settings or shared state wait for this machine. It applies the current state when it connects.`}
    >
      queued {props.view.queued}
    </span>
  );
}

/** K-1702: the start of a fingerprint is enough to compare it by eye. */
const shortFingerprint = (fingerprint: string) => `${fingerprint.slice(0, "SHA256:".length + 12)}…`;

/** K-1702, K-1705, K-1706: the key of the machine, "Rotate key" and "Reset key". */
function MachineKeyRow(props: { view: MachineView; onToast: (text: string, error: boolean) => void }) {
  const { machine, keyFailure } = props.view;
  const [rekey, setRekey] = useState<{ command: string; expiresAt: number } | null>(null);
  const path = `/api/machines/${encodeURIComponent(machine.id)}`;
  const rotate = async () => {
    const result = await callApi<{ rotating: string }>("POST", `${path}/rotate-key`, {});
    props.onToast(
      "error" in result ? result.error : `${machine.name} rotates its key now.`,
      "error" in result,
    );
  };
  const reset = async () => {
    const result = await callApi<{ command: string; expiresAt: number }>("POST", `${path}/reset-key`, {});
    if ("error" in result) props.onToast(result.error, true);
    else setRekey(result);
  };
  return (
    <>
      <div class="row">
        <span class="label" data-tip="Key: the key pair that the machine proves itself with to kitshn.">
          Key
        </span>
        {machine.key?.kind === "public" ? (
          <span class="mono" data-tip={`The fingerprint of the machine key: ${machine.key.fingerprint}`}>
            {shortFingerprint(machine.key.fingerprint)} · {ago(machine.key.since)} old
          </span>
        ) : (
          <>
            <KeySticker view={props.view} />
            <QueuedSticker view={props.view} />
          </>
        )}
        <button
          class="btn"
          disabled={machine.key?.kind !== "public" || !props.view.online}
          data-tip="Rotate key: the online machine makes a new key pair and sends its public half."
          onClick={() => void rotate()}
        >
          Rotate key
        </button>
        <button
          class="btn"
          data-tip="Make a one-time rekey command; the machine gets a new key when you run it there."
          onClick={() => void reset()}
        >
          {machine.key === undefined ? "Make key code" : "Reset key"}
        </button>
      </div>
      {keyFailure ? (
        <p class="muted">
          Failed check {ago(keyFailure.at)} ago: {keyFailure.reason}
        </p>
      ) : null}
      {props.view.status?.attesters?.length ? (
        <p
          class="muted"
          data-tip="Attesters: local services that vouch for the thread of an ask; only their labels count for rights (K-1751)."
        >
          Attesters:{" "}
          {props.view.status.attesters.map((attester) => `${attester.prefix} ${attester.address}`).join(", ")}
        </p>
      ) : null}
      {rekey ? (
        <>
          <p>
            Run this on the machine, as the user that runs the daemon. It works once, until{" "}
            {new Date(rekey.expiresAt).toLocaleTimeString()}.
          </p>
          <pre class="command">{rekey.command}</pre>
        </>
      ) : null}
    </>
  );
}

/** K-602: "Add machine" makes a service token, a tunnel and a join code that works once for 10 minutes. */
export function AddMachine(props: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [labels, setLabels] = useState("");
  const [result, setResult] = useState<{ command: string; windowsCommand: string; expiresAt: number } | null>(
    null,
  );
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
            <p>On Windows, in PowerShell:</p>
            <pre class="command">{result.windowsCommand}</pre>
            <div class="row">
              <button
                class="btn primary"
                data-tip="Copy the join command for Linux and macOS to the clipboard."
                onClick={() => void navigator.clipboard.writeText(result.command)}
              >
                Copy
              </button>
              <button
                class="btn"
                data-tip="Copy the join command for Windows PowerShell to the clipboard."
                onClick={() => void navigator.clipboard.writeText(result.windowsCommand)}
              >
                Copy for Windows
              </button>
              <button
                class="btn"
                data-tip="Close this dialog. The command keeps working until it expires."
                onClick={props.onClose}
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const response = await callApi<{ command: string; windowsCommand: string; expiresAt: number }>(
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
            <p class="muted">The new machine card starts in the tray, so it is private until you place it.</p>
            <input
              class="field"
              aria-label="Machine name"
              data-tip="The name of the machine card."
              placeholder="Name, for example Oracle VPS"
              value={name}
              onInput={(event) => setName((event.target as HTMLInputElement).value)}
            />
            <input
              class="field"
              aria-label="Labels"
              data-tip="Labels, split by commas. A job runs on the first online machine that has all labels that it needs."
              placeholder="Labels, for example docker, server, arm"
              value={labels}
              onInput={(event) => setLabels((event.target as HTMLInputElement).value)}
            />
            <div class="row">
              <button
                class="btn primary"
                data-tip="Make a join command with a code that works once, for 10 minutes."
              >
                Make a join code
              </button>
              <button
                class="btn"
                type="button"
                data-tip="Close this dialog; nothing changes."
                onClick={props.onClose}
              >
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
      : command.kind === "compose-volume-remove"
        ? `delete volume ${command.volume}`
        : command.kind;

/** K-612: queues one command on a machine, and says what happened. */
export async function queueJob(
  machineId: string,
  command: Command,
): Promise<{ text: string; error: boolean }> {
  const result = await callApi<{ id: number }>("POST", "/api/jobs", { machineId, command });
  return "error" in result
    ? { text: result.error, error: true }
    : { text: `Job #${result.id} is queued.`, error: false };
}

/** The machine part of the card panel: status, sample, commands (K-612) and removal (K-615). */
export function MachinePanel(props: {
  view: MachineView;
  /** K-617: the release of this kitshn. */
  version: string;
  jobs: ReadonlyArray<JobView>;
  onRemove: () => void;
  onRun: (command: Command) => Promise<void>;
  onToast: (text: string, error: boolean) => void;
}) {
  const { view } = props;
  const [script, setScript] = useState("");
  const run = props.onRun;
  const jobs = props.jobs.filter((job) => job.machineId === view.machine.id);
  return (
    <>
      <div class="row">
        <PresenceSticker view={view} />
        {view.status ? (
          <span class="muted">
            {view.status.hostname} · {view.status.os} · {view.status.arch} · kitshn {view.status.version} ·
            tunnel {view.status.tunnel}
            {view.status.keptBytes === undefined ? null : (
              <span data-tip="Kept builds (K-821): the images that this machine keeps for rollbacks, at most; shared layers count once per image.">
                {" "}
                · kept builds up to {Math.round(view.status.keptBytes / 1024 / 1024)} MB
              </span>
            )}
          </span>
        ) : null}
      </div>
      <MachineKeyRow view={view} onToast={props.onToast} />
      {view.sample ? (
        <div class="row">
          <span class="label" data-tip="CPU: the share in use, from the latest sample of the minute.">
            CPU
          </span>{" "}
          {percent(view.sample.cpu)}{" "}
          <span class="label" data-tip="Memory: the share in use, from the latest sample of the minute.">
            Memory
          </span>{" "}
          {percent(view.sample.memory)}{" "}
          <span class="label" data-tip="Disk: the share in use, from the latest sample of the minute.">
            Disk
          </span>{" "}
          {percent(view.sample.disk)}
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
          class="field"
          name="labels"
          aria-label="Labels"
          data-tip="Labels, split by commas. A job runs on the first online machine that has all labels that it needs."
          key={view.machine.labels.join(",")}
          defaultValue={view.machine.labels.join(", ")}
          placeholder="docker, server"
        />
        <button class="btn" data-tip="Save the labels of this machine.">
          Save
        </button>
      </form>
      <form
        class="allow-list"
        onSubmit={async (event) => {
          event.preventDefault();
          const input = (event.currentTarget as HTMLFormElement).elements.namedItem(
            "allow",
          ) as HTMLTextAreaElement;
          const lines = input.value
            .split("\n")
            .map((line) => line.trim().split(/\s+/))
            .filter((words) => words[0]);
          const long = lines.find((words) => words.length > 2);
          if (long) {
            props.onToast(
              `"${long.join(" ")}" has more than a repo and one setting; write one setting per line.`,
              true,
            );
            return;
          }
          const allow = lines.map(([repo = "", setting = ""]) => ({ repo, setting }));
          const result = await callApi<{ id: string }>(
            "POST",
            `/api/machines/${encodeURIComponent(view.machine.id)}`,
            { allow },
          );
          props.onToast(
            "error" in result ? String(result.error) : "Saved the allowed Compose settings.",
            "error" in result,
          );
        }}
      >
        <span
          class="label"
          data-tip="Allowed Compose settings: the risky settings that deploys on this machine may use."
        >
          Allowed Compose settings
        </span>
        <p class="help">
          One line per repo and setting, for example{" "}
          <code>Yarden-zamir/dozzle bind:/var/run/docker.sock</code>. A deploy names the setting it needs when
          it stops.
        </p>
        <textarea
          name="allow"
          aria-label="Allowed Compose settings"
          data-tip="One repo and one risky Compose setting per line. A deploy on this machine may use only these."
          rows={3}
          class="mono"
          key={(view.machine.allow ?? []).map((entry) => `${entry.repo} ${entry.setting}`).join("|")}
          defaultValue={(view.machine.allow ?? [])
            .map((entry) => `${entry.repo} ${entry.setting}`)
            .join("\n")}
        />
        <button class="btn" data-tip="Save the allowed Compose settings of this machine.">
          Save
        </button>
      </form>
      <div
        class="label"
        style={{ marginTop: "10px" }}
        data-tip="Commands: jobs that the daemon runs. They need control on the machine card."
      >
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
          class="field mono"
          aria-label="Shell command"
          data-tip="A shell command that the daemon runs as a job. It needs control on the machine card."
          placeholder="Shell command, needs control"
          value={script}
          onInput={(event) => setScript((event.target as HTMLInputElement).value)}
        />
        <button class="btn" data-tip="Queue the command as a job; it waits while the machine is offline.">
          Run
        </button>
      </form>
      <div class="row">
        <button
          class="btn"
          data-tip="Collect diagnostics of the daemon as a job; the output shows below."
          onClick={() => void run({ kind: "diagnostics" })}
        >
          Diagnostics
        </button>
        <button class="btn" data-tip={MACHINE_TIPS.restart} onClick={() => void run({ kind: "restart" })}>
          Restart daemon
        </button>
        {/* A local build names no release, so there is nothing to update to (K-617). */}
        {isRelease(props.version) ? (
          <button
            class={`btn${view.status && view.status.version !== props.version ? " primary" : ""}`}
            data-tip={MACHINE_TIPS.update(props.version)}
            onClick={() => void run({ kind: "update", version: props.version })}
          >
            {view.status && view.status.version !== props.version
              ? `Update daemon to ${props.version}`
              : "Update daemon"}
          </button>
        ) : null}
      </div>
      {view.orphanVolumes.length > 0 ? (
        <>
          <div
            class="label"
            style={{ marginTop: "10px" }}
            data-tip="Orphaned volumes: volumes of removed apps that still hold their data on this machine."
          >
            Orphaned volumes
          </div>
          <p class="help">Volumes of removed apps. Undo of a removal does not bring back a deleted volume.</p>
          <ul>
            {view.orphanVolumes.map((volume) => (
              <li key={volume.name}>
                <div class="row">
                  <code>{volume.name}</code>
                  <button
                    class="btn danger"
                    data-tip={`Delete the volume ${volume.name} and its data. Undo cannot bring it back.`}
                    onClick={() =>
                      void run({
                        kind: "compose-volume-remove",
                        project: volume.project,
                        volume: volume.name,
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <ul>
        {jobs.slice(0, 5).map((job) => (
          <li key={job.id}>
            <div class="row">
              <code>#{job.id}</code> <code>{describe(job.command)}</code>
              <span
                class={`sticker ${job.state === "done" ? "ok" : job.state === "queued" || job.state === "sent" ? "wait" : ""}`}
                data-tip={JOB_TIPS[job.state]}
              >
                {job.state}
              </span>
            </div>
            {job.output ? <pre class="output">{job.output}</pre> : null}
          </li>
        ))}
      </ul>
      <button class="btn danger" data-tip={MACHINE_TIPS.remove} onClick={props.onRemove}>
        Remove machine: deletes its token and tunnel
      </button>
    </>
  );
}

/** K-519: the Machines view, a table of status and health. */
export function MachinesView(props: { machines: ReadonlyArray<MachineView>; onAdd: () => void }) {
  return (
    <div class="table-view">
      <p class="muted">
        Each machine runs the kitshn daemon. Commands and jobs need control on the machine card.
      </p>
      <button
        class="btn primary"
        data-tip="Make a join command for a new machine. Its card starts in the tray, private."
        onClick={props.onAdd}
      >
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
                <a
                  href={`#map/${view.machine.id}`}
                  data-tip="Show the machine card and its panel on the map."
                >
                  {view.machine.name}
                </a>
              </td>
              <td data-label="Status">
                <PresenceSticker view={view} />
              </td>
              <td data-label="Labels">{view.machine.labels.join(", ")}</td>
              <td data-label="CPU">{percent(view.sample?.cpu)}</td>
              <td data-label="Memory">{percent(view.sample?.memory)}</td>
              <td data-label="Disk">{percent(view.sample?.disk)}</td>
              <td data-label="Daemon">
                {view.status ? `${view.status.version} · ${view.status.arch}` : "–"}
              </td>
            </tr>
          ))}
          {props.machines.length === 0 ? (
            <tr>
              <td colSpan={7}>No machine yet. Add one; the command joins it in one step.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
