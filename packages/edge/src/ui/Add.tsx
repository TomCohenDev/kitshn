import { useState } from "preact/hooks";
import type { MachineView } from "../core/protocol.ts";
import { RESERVED_SITE_NAMES } from "../core/library.ts";
import { Radio, Switch } from "./controls.tsx";
import { callApi } from "./store.ts";

const isName = (name: string) =>
  name.length > 0 &&
  name.length <= 40 &&
  !name.startsWith("-") &&
  !name.endsWith("-") &&
  [...name].every((c) => c === "-" || (c >= "a" && c <= "z") || (c >= "0" && c <= "9"));

/** A port, or an absolute socket path that a shell can take in single quotes. */
function targetError(target: string): string | null {
  if (target.startsWith("/"))
    return target.includes("'") || target.includes(" ")
      ? "A socket path cannot have a quote or a space."
      : null;
  const port = Number(target);
  return Number.isInteger(port) && port > 0 && port < 65536 && String(port) === target
    ? null
    : "Type a port, for example 5173, or a socket path, for example /run/app.sock.";
}

const RECIPE = `import { defineApp } from "kitshn";

export default defineApp({
  // The build runs in GitHub Actions; leave it out when the repo has the site files already.
  static: { build: "npm ci && npm run build", output: "dist" },
  deploy: [
    { on: "push", branch: "main", name: "prod" },
    { on: "pull_request", name: "pr-{pr}", ephemeral: true },
  ],
});`;

const workflow = (server: string) => `name: kitshn
on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, closed]
  workflow_dispatch:
permissions:
  contents: read
  id-token: write
jobs:
  kitshn:
    uses: Yarden-zamir/kitshn/.github/workflows/kitshn2-deploy.yml@main
    with:
      server: ${server}`;

function Snippet(props: { file: string; text: string }) {
  return (
    <div>
      <div class="row">
        <code>{props.file}</code>
        <button
          type="button"
          class="btn"
          data-tip={`Copy ${props.file} to the clipboard.`}
          onClick={() => void navigator.clipboard.writeText(props.text)}
        >
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
  const [picked, setPicked] = useState("");
  // A machine that comes online while the dialog is open becomes the default.
  const machineId = online.some((view) => view.machine.id === picked)
    ? picked
    : (online[0]?.machine.id ?? "");
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
        : RESERVED_SITE_NAMES.has(name)
          ? `${name}.${props.zone} belongs to kitshn itself. Pick another name.`
          : targetError(target.trim());
    if (problem) return setError(problem);
    setBusy(true);
    // An older daemon has no $KITSHN; the join script installs the binary in ~/.local/bin.
    const script = `"\${KITSHN:-$HOME/.local/bin/kitshn}" expose '${target.trim()}' --name '${name}'${dev ? " --dev" : ""}`;
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
          <button
            type="button"
            aria-pressed={kind === "live"}
            data-tip="Live: a local server of a machine, through its tunnel, while the machine is on."
            onClick={() => setKind("live")}
          >
            Live, from a machine
          </button>
          <button
            type="button"
            aria-pressed={kind === "static"}
            data-tip="Static: GitHub Actions builds the repo and kitshn serves the files."
            onClick={() => setKind("static")}
          >
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
              <span class="label" data-tip="Machine: the online machine that runs the local server.">
                Machine
              </span>
              {online.length === 0 ? (
                <span class="help">No machine is online. Start a daemon first.</span>
              ) : (
                <div class="choices" role="radiogroup" aria-label="Machine">
                  {online.map((view) => (
                    <Radio
                      key={view.machine.id}
                      name="site-machine"
                      checked={view.machine.id === machineId}
                      label={view.machine.name}
                      tip={`Share a server of ${view.machine.name}.`}
                      onSelect={() => setPicked(view.machine.id)}
                    />
                  ))}
                </div>
              )}
            </div>
            <div class="field-row">
              <span class="label" data-tip="Server: the port or the Unix socket of the local server.">
                Server
              </span>
              <input
                value={target}
                aria-label="Server"
                data-tip="The port or the Unix socket of the local server on the machine."
                placeholder="5173 or /run/app.sock"
                onInput={(event) => setTarget((event.target as HTMLInputElement).value)}
              />
            </div>
            <div class="field-row">
              <span class="label" data-tip="Name: the first part of the address of the site.">
                Name
              </span>
              <div>
                <input
                  value={name}
                  aria-label="Name"
                  data-tip="The name of the site: 1 to 40 lowercase letters, digits and dashes. It is the first part of the address."
                  placeholder="my-app"
                  onInput={(event) => setName((event.target as HTMLInputElement).value.toLowerCase())}
                />
                <p class="help">
                  At <code>{(name || "name") + "." + props.zone}</code>
                </p>
              </div>
            </div>
            <div class="field-row">
              <span class="label" data-tip="Dev: whether the server is a dev server such as Vite.">
                Dev
              </span>
              <div>
                <Switch
                  checked={dev}
                  label="A dev server"
                  tip="A dev server: kitshn sends Host: localhost, because Vite and similar servers refuse other hosts."
                  onChange={setDev}
                />
                <p class="help">
                  Vite and similar servers refuse other hosts, so kitshn sends <code>Host: localhost</code>.
                </p>
              </div>
            </div>
            {error ? <p class="error">{error}</p> : null}
            <div class="row">
              <button
                class="btn primary"
                disabled={busy || online.length === 0}
                data-tip="Send the machine a job that shares the server. The card then waits in the tray, private."
              >
                Share it
              </button>
              <button
                type="button"
                class="btn"
                data-tip="Close this dialog; nothing changes."
                onClick={props.onClose}
              >
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
            <Snippet file=".github/workflows/kitshn.yml" text={workflow(location.origin)} />
            <div class="row">
              <button type="button" class="btn" data-tip="Close this dialog." onClick={props.onClose}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
