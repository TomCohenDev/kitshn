import { useState } from "preact/hooks";
import type { MachineView } from "../core/protocol.ts";
import { Toggle } from "./Circle.tsx";
import { callApi } from "./store.ts";

/** Names that kitshn itself uses on the zone (K-1003, K-1102); a live site cannot take them. */
const RESERVED = new Set(["pages", "files", "kit", "www"]);

const isName = (name: string) =>
  name.length > 0 &&
  name.length <= 40 &&
  !name.startsWith("-") &&
  !name.endsWith("-") &&
  [...name].every((c) => c === "-" || (c >= "a" && c <= "z") || (c >= "0" && c <= "9"));

/** A port, or an absolute socket path that a shell can take in single quotes. */
function targetError(target: string): string | null {
  if (target.startsWith("/")) return target.includes("'") ? "A socket path cannot have a quote." : null;
  const port = Number(target);
  return Number.isInteger(port) && port > 0 && port < 65536 && String(port) === target
    ? null
    : "Type a port, for example 5173, or a socket path, for example /run/app.sock.";
}

const RECIPE = `import { defineApp } from "kitshn";

export default defineApp({
  static: { output: "dist" },
  deploy: [
    { on: "push", branch: "main", name: "prod" },
    { on: "pull_request", name: "pr-{pr}", ephemeral: true },
  ],
});`;

const WORKFLOW = `name: kitshn
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, closed]
permissions:
  contents: read
  id-token: write
jobs:
  kitshn:
    uses: Yarden-zamir/kitshn/.github/workflows/kitshn2-deploy.yml@main`;

function Snippet(props: { file: string; text: string }) {
  return (
    <div>
      <div class="row">
        <code>{props.file}</code>
        <button type="button" class="btn" onClick={() => void navigator.clipboard.writeText(props.text)}>
          Copy
        </button>
      </div>
      <pre class="command">{props.text}</pre>
    </div>
  );
}

/** K-805, K-1104: a static site from a repo, or a live site from a machine. */
export function AddSite(props: {
  zone: string;
  machines: ReadonlyArray<MachineView>;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const [kind, setKind] = useState<"live" | "static">("live");
  const online = props.machines.filter((view) => view.online);
  const [machineId, setMachineId] = useState(online[0]?.machine.id ?? "");
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [dev, setDev] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const share = async () => {
    const problem = !machineId
      ? "Pick a machine that is online."
      : !isName(name)
        ? "A name has 1 to 40 lowercase letters, digits and dashes."
        : RESERVED.has(name)
          ? `${name}.${props.zone} belongs to kitshn itself. Pick another name.`
          : targetError(target.trim());
    if (problem) return setError(problem);
    setBusy(true);
    const script = `"\${KITSHN:-kitshn}" expose '${target.trim()}' --name '${name}'${dev ? " --dev" : ""}`;
    const result = await callApi<{ id: number }>("POST", "/api/jobs", {
      machineId,
      command: { kind: "shell", script },
    });
    setBusy(false);
    if ("error" in result) return setError(result.error);
    props.onDone(
      `The machine shares ${name}.${props.zone} when its daemon picks it up. The card waits in the tray.`,
    );
    props.onClose();
  };
  return (
    <div class="scrim" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <div class="dialog" role="dialog" aria-label="Add a site">
        <h2>Add a site</h2>
        <div class="seg">
          <button type="button" aria-pressed={kind === "live"} onClick={() => setKind("live")}>
            Live, from a machine
          </button>
          <button type="button" aria-pressed={kind === "static"} onClick={() => setKind("static")}>
            Static, from a repo
          </button>
        </div>
        {kind === "live" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void share();
            }}
          >
            <p class="help">
              A local server of a machine, through its tunnel. It is live only while the machine is on.
            </p>
            <div class="field-row">
              <span class="label">Machine</span>
              {online.length === 0 ? (
                <span class="help">No machine is online. Start a daemon first.</span>
              ) : (
                <select
                  value={machineId}
                  onChange={(event) => setMachineId((event.target as HTMLSelectElement).value)}
                >
                  {online.map((view) => (
                    <option key={view.machine.id} value={view.machine.id}>
                      {view.machine.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div class="field-row">
              <span class="label">Server</span>
              <input
                value={target}
                placeholder="5173 or /run/app.sock"
                onInput={(event) => setTarget((event.target as HTMLInputElement).value)}
              />
            </div>
            <div class="field-row">
              <span class="label">Name</span>
              <div>
                <input
                  value={name}
                  placeholder="my-app"
                  onInput={(event) => setName((event.target as HTMLInputElement).value.toLowerCase())}
                />
                <p class="help">
                  At <code>{(name || "name") + "." + props.zone}</code>
                </p>
              </div>
            </div>
            <div class="field-row">
              <span class="label">Dev</span>
              <div>
                <Toggle checked={dev} label="A dev server" onChange={setDev} />
                <p class="help">
                  Vite and similar servers refuse other hosts, so kitshn sends <code>Host: localhost</code>.
                </p>
              </div>
            </div>
            {error ? <p class="error">{error}</p> : null}
            <div class="row">
              <button class="btn primary" disabled={busy || online.length === 0}>
                Share it
              </button>
              <button type="button" class="btn" onClick={props.onClose}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div>
            <p class="help">
              Add these two files to the repo and push to main. GitHub Actions deploys it, and its card lands
              in the tray, private, until you place it in a circle.
            </p>
            <Snippet file="kitshn.config.ts" text={RECIPE} />
            <Snippet file=".github/workflows/kitshn.yml" text={WORKFLOW} />
            <div class="row">
              <button type="button" class="btn" onClick={props.onClose}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
