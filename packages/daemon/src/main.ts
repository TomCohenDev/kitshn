// The kitshn daemon (SPEC section 6). One program: `kitshn join`, `kitshn run`, `kitshn service`.
import {
  connectText,
  fingerprintOf,
  newMachineKey,
  openJoin,
  parsePrivateKey,
  rotateText,
  signText,
  type Command,
  type DaemonMessage,
  type JoinSecrets,
  type MachinePrivateKey,
  type ProjectVolume,
  type ServerToDaemon,
} from "@kitshn/edge/machine";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { Answer, Request } from "@kitshn/local";
import { composeFiles, composeRisks, envFileRisks, rawRisks, realpathOnDisk, sourceRisks } from "./guard.ts";
import { keyPlan } from "./keys.ts";
import { type LocalOutcome, askLocal, listenLocal } from "./local.ts";
import { localUsersOf, peerDecision } from "./peer.ts";
import { movedVolume, takeoverPlan } from "./kitshn1.ts";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import {
  arch,
  cpus,
  freemem,
  hostname,
  loadavg,
  platform as osPlatform,
  release,
  totalmem,
  uptime,
} from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type Platform,
  RELEASES,
  cloudflaredUrl,
  expectedHash,
  pathsFor,
  releaseAsset,
  serviceCommands,
  serviceFile,
  tunnelCommands,
  tunnelServiceFile,
  tunnelStateOf,
} from "./service.ts";
import { type SiteEntry, addSite, parseSiteFile, probe, targetOf } from "./sites.ts";
import { RUNNING_FORMAT, VOLUME_FORMAT, idleVolumes, volumeRemoveRefusal } from "./volumes.ts";

declare const KITSHN_VERSION: string;
const VERSION = typeof KITSHN_VERSION === "string" ? KITSHN_VERSION : "dev";

const platform = ((): Platform => {
  const value = osPlatform();
  if (value === "linux" || value === "darwin") return value;
  throw new Error(`kitshn runs on Linux and macOS (K-601), not on ${value}.`);
})();
const paths = pathsFor(platform, process.env);

/** K-605: status at most every 5 seconds, a sample once a minute. K-604: a ping every 10 seconds. */
const PING_MS = 10_000;
const PONG_TIMEOUT_MS = 30_000;
const SAMPLE_MS = 60_000;
const HISTORY_DAYS = 30;
const JOB_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 64 * 1024;

const log = (text: string) => console.log(`${new Date().toISOString()} ${text}`);

function fail(text: string): never {
  console.error(`kitshn: ${text}`);
  process.exit(1);
}

function readConfig(): JoinSecrets {
  if (!existsSync(paths.config))
    fail(`this machine has not joined yet. Run: kitshn join <code> --server <address>`);
  return JSON.parse(readFileSync(paths.config, "utf8")) as JoinSecrets;
}

/**
 * K-1702: the private half of the machine key lives next to `machine.json`, mode 0600 in a folder with mode
 * 0700. During a rotation the new half waits in `machine.key.next` until kitshn has it (K-1705).
 */
const keyFile = join(dirname(paths.config), "machine.key");
const nextKeyFile = `${keyFile}.next`;
/** K-1703, K-1706: a key from a join or rekey code waits here until kitshn takes it. */
const codeKeyFile = `${keyFile}.rekey`;

/** The key in a file, or null when the file is missing. A broken file stops the daemon (K-006). */
function readKey(file: string): MachinePrivateKey | null {
  if (!existsSync(file)) return null;
  const key = parsePrivateKey(JSON.parse(readFileSync(file, "utf8")));
  if (!key) fail(`${file} holds no Ed25519 key. Use Reset key on the map, then kitshn rekey <code>.`);
  return key;
}

/** Writes a key through a rename, so a stop never leaves half a key. */
function writeKey(file: string, key: MachinePrivateKey) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(key)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

/**
 * K-602, K-1703: trades the join code and the public half of a new machine key for the machine secrets, and saves
 * both for the daemon user only.
 */
async function joinCommand(code: string | undefined, server: string | undefined) {
  if (!code || !server) fail("usage: kitshn join <code> --server https://kit.example.com");
  // K-1703: the key pair comes first, in machine.key.rekey before kitshn stores its public half, so a wrong code
  // never replaces a valid key. The next challenge that names it promotes it.
  const key = await newMachineKey();
  writeKey(codeKeyFile, key);
  const response = await fetch(new URL("/join/exchange", server), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, publicKey: key.x }),
  });
  const body = (await response.json().catch(() => null)) as {
    iv?: string;
    sealed?: string;
    error?: string;
  } | null;
  if (!response.ok || !body?.iv || !body.sealed) {
    rmSync(codeKeyFile, { force: true });
    fail(body?.error ?? `the server answered ${response.status}.`);
  }
  const secrets = await openJoin(code, { iv: body.iv, sealed: body.sealed });
  mkdirSync(dirname(paths.config), { recursive: true, mode: 0o700 });
  // An older file can have looser permissions; tighten them before the secrets go in.
  if (existsSync(paths.config)) chmodSync(paths.config, 0o600);
  writeFileSync(paths.config, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  renameSync(codeKeyFile, keyFile);
  console.log(`Joined as machine ${secrets.machineId} with the key ${await fingerprintOf(key.x)}.`);
}

/**
 * K-1706, K-1708: trades a key code for a new key, then asks the running daemon to connect again with it. Only
 * the daemon's own connection to kitshn changes; the tunnel and the apps keep serving. A stopped daemon signs
 * with the new `machine.key` when it starts.
 */
async function rekeyCommand(code: string | undefined) {
  if (!code) fail("usage: kitshn rekey <code>");
  const config = readConfig();
  // In its own file before kitshn stores its public half, so a failed write cannot lock the machine out, a wrong
  // code cannot replace a valid key, and a rotation or a reconnect never touches it. The next challenge that
  // names it promotes it.
  const key = await newMachineKey();
  writeKey(codeKeyFile, key);
  const response = await fetch(new URL("/join/rekey", config.server), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, machineId: config.machineId, publicKey: key.x }),
  });
  const body = (await response.json().catch(() => null)) as { fingerprint?: string; error?: string } | null;
  if (!response.ok || !body?.fingerprint) {
    rmSync(codeKeyFile, { force: true });
    fail(body?.error ?? `the server answered ${response.status}.`);
  }
  renameSync(codeKeyFile, keyFile);
  console.log(`Saved the new key ${body?.fingerprint} in ${keyFile}.`);
  const answer = await ask({ id: "1", type: "reconnect" });
  console.log(
    answer === null
      ? "The daemon is not running. It signs with the new key when it starts."
      : "The daemon connects again with the new key.",
  );
}

/** K-1705: asks the running daemon to rotate its key over its connection. */
async function rotateKeyCommand() {
  const answer = await ask({ id: "1", type: "rotate-key" });
  if (answer === null) fail(notRunning);
  if (answer.type !== "rotate-key") fail(`the daemon answered ${answer.type} to rotate-key.`);
  console.log(`Rotated. The new key is ${answer.fingerprint}.`);
}

async function statusCommand() {
  const answer = await ask({ id: "1", type: "status" });
  if (answer === null) fail(notRunning);
  if (answer.type !== "status") fail(`the daemon answered ${answer.type} to status.`);
  const { status } = answer;
  console.log(
    [
      `version  ${status.version}`,
      `machine  ${status.machineId}`,
      `key      ${status.fingerprint ?? "none (kitshn rekey <code>)"}`,
      `kitshn   ${status.connection}`,
      `tunnel   ${status.tunnel}`,
    ].join("\n"),
  );
}

/** K-701: where the commands find the daemon. `KITSHN_LOCAL_SOCKET` names the socket for a user other than its own. */
const socketPath = process.env["KITSHN_LOCAL_SOCKET"] || paths.socket;
const notRunning = `the daemon is not running (no daemon listens on ${socketPath}). Start it with: kitshn service install`;

/** K-702: one request to the running daemon; null when it does not run. An error answer ends the command. */
async function ask(request: Request): Promise<Exclude<Answer, { type: "error" }> | null> {
  // A rotation waits for kitshn to store the new key (K-1705).
  const outcome: LocalOutcome = await askLocal(socketPath, request, 30_000).catch((error: unknown) =>
    fail(error instanceof Error ? error.message : String(error)),
  );
  if (outcome.kind === "not-running") return null;
  if (outcome.answer.type === "error") fail(outcome.answer.error);
  return outcome.answer;
}

/**
 * K-701: `kitshn local-users list|add|remove [user]` edits `localUsers` in `machine.json`. Only the daemon user
 * (and root) can read that file. The daemon reads the list at each new connection.
 */
function localUsersCommand(action: string | undefined, who: string | undefined) {
  readConfig();
  const machine = JSON.parse(readFileSync(paths.config, "utf8")) as Record<string, unknown>;
  const users = localUsersOf(machine);
  if (users === null) fail(`localUsers in ${paths.config} is not a list of user ids. Fix it by hand.`);
  const own = process.getuid!();
  if (action === "list") {
    console.log([`${own} (the daemon user)`, ...users.map(String)].join("\n"));
    return;
  }
  if ((action !== "add" && action !== "remove") || !who) fail("usage: kitshn local-users list|add|remove <user or uid>");
  const uid = uidOf(who);
  if (uid === own) fail("the daemon user always can use the local socket.");
  // K-701: the socket folder is 0700 (on Linux also the folder $XDG_RUNTIME_DIR), so only root reaches it.
  if (action === "add" && uid !== 0)
    fail(`only root can reach the socket of this user, so the user id ${uid} cannot connect (K-701).`);
  const next = action === "add" ? [...new Set([...users, uid])] : users.filter((user) => user !== uid);
  // Through a rename, so a stop never leaves half of the file that holds the machine token.
  const temporary = `${paths.config}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...machine, localUsers: next }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, paths.config);
  console.log(`Local users: ${next.length > 0 ? next.join(", ") : "none"}, and the daemon user ${own}.`);
}

/** A user id, from a number or a user name. */
function uidOf(who: string): number {
  if ([...who].every((char) => char >= "0" && char <= "9")) return Number(who);
  const result = spawnSync("id", ["-u", who], { encoding: "utf8" });
  if (result.status !== 0) fail(`there is no user ${who}.`);
  return Number(result.stdout.trim());
}

const run = (argv: ReadonlyArray<string>, mayFail = false) => {
  const [program = "", ...rest] = argv;
  const result = spawnSync(program, rest, { stdio: "inherit" });
  if (result.status !== 0 && !mayFail) fail(`${argv.join(" ")} failed.`);
};

const tunnel = tunnelCommands(platform, paths.tunnelService, process.getuid?.() ?? 0);

/** Writes a file only when its text changes. Returns whether it changed. */
function writeChanged(file: string, text: string, mode: number): boolean {
  if (existsSync(file) && readFileSync(file, "utf8") === text) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
  return true;
}

/**
 * K-603: installs the tunnel as its own user service and starts it. It restarts the tunnel only when cloudflared,
 * its token or its service file changed, so a daemon restart or update never stops the tunnel.
 */
async function ensureTunnel(config: JoinSecrets) {
  const { file: binary, fresh } = await ensureCloudflared();
  const tokenFile = join(paths.data, "tunnel-token");
  const tokenChanged = writeChanged(tokenFile, config.tunnelToken, 0o600);
  const unitChanged = writeChanged(paths.tunnelService, tunnelServiceFile(platform, binary, tokenFile), 0o644);
  const steps = fresh || tokenChanged || unitChanged ? tunnel.restart : tunnel.start;
  for (const step of steps) run(step.argv, step.mayFail);
}

/**
 * K-603, K-615: stops and removes the tunnel service and its token file, after "Remove machine" or on
 * `kitshn service uninstall`. The cloudflared binary stays in the data folder.
 */
function removeTunnel() {
  for (const step of tunnel.stop) run(step.argv, step.mayFail);
  rmSync(paths.tunnelService, { force: true });
  rmSync(join(paths.data, "tunnel-token"), { force: true });
}

async function serviceCommand(action: string | undefined) {
  const file = paths.service;
  const commands = serviceCommands(platform, file, process.getuid?.() ?? 0);
  if (action === "install") {
    // The tunnel service starts before the old daemon stops, so a daemon that still runs its own cloudflared
    // hands over with no gap.
    await ensureTunnel(readConfig());
    mkdirSync(dirname(file), { recursive: true });
    // A second install replaces the running daemon, for example after a new download.
    for (const argv of commands.stop) run(argv, true);
    writeFileSync(file, serviceFile(platform, process.execPath));
    for (const argv of commands.start) run(argv);
    console.log(`kitshn runs as a user service (${file}).`);
    if (platform === "linux") {
      console.log("For a start without a login, the user needs lingering: loginctl enable-linger $USER");
    }
  } else if (action === "uninstall") {
    for (const argv of commands.stop) run(argv, true);
    rmSync(file, { force: true });
    removeTunnel();
    const folders = [...new Set([dirname(paths.config), paths.data])];
    console.log(
      `Removed ${file}, ${paths.tunnelService} and the tunnel token. These folders stay: ${folders.join(", ")}` +
        ` (${paths.config} and machine.key hold the machine token and key; the data folder holds cloudflared,` +
        ` the apps and the sample history). Delete them with: rm -r ${folders.map((folder) => `"${folder}"`).join(" ")}`,
    );
  } else fail("usage: kitshn service install|uninstall");
}

/** K-603: the cloudflared of the tunnel service, downloaded once. `fresh` says that this call downloaded it. */
async function ensureCloudflared(): Promise<{ file: string; fresh: boolean }> {
  const file = join(paths.data, "cloudflared");
  if (existsSync(file)) return { file, fresh: false };
  mkdirSync(paths.data, { recursive: true });
  const { url, archive } = cloudflaredUrl(platform, arch());
  log(`downloading cloudflared from ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`cloudflared download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (archive) {
    const tgz = `${file}.tgz`;
    writeFileSync(tgz, bytes);
    const result = spawnSync("tar", ["-xzf", tgz, "-C", paths.data]);
    rmSync(tgz, { force: true });
    if (result.status !== 0) throw new Error("cloudflared archive could not be unpacked.");
  } else writeFileSync(file, bytes);
  chmodSync(file, 0o755);
  return { file, fresh: true };
}

function sample() {
  const disk = statfsSync("/");
  return {
    at: Date.now(),
    cpu: Math.min(1, (loadavg()[0] ?? 0) / Math.max(1, cpus().length)),
    memory: 1 - freemem() / totalmem(),
    disk: 1 - disk.bavail / disk.blocks,
  };
}

/** K-606: the daemon keeps 30 days of samples on its own disk. */
function keepSample(value: ReturnType<typeof sample>) {
  const file = join(paths.data, "samples.jsonl");
  mkdirSync(paths.data, { recursive: true });
  appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function pruneSamples() {
  const file = join(paths.data, "samples.jsonl");
  if (!existsSync(file)) return;
  const cutoff = Date.now() - HISTORY_DAYS * 24 * 60 * 60_000;
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line && (JSON.parse(line) as { at: number }).at >= cutoff);
  writeFileSync(file, lines.length ? `${lines.join("\n")}\n` : "");
}

/**
 * K-612, K-617: downloads the daemon of the release that kitshn names, checks it against the release's
 * SHA256SUMS, puts it in place of this binary, and exits; the service manager starts the new one.
 */
async function updateDaemon(
  version: string,
): Promise<{ ok: boolean; exitCode: number | null; output: string }> {
  const failed = (output: string) => ({ ok: false, exitCode: null, output });
  if (!/^[0-9a-f]{12}$/.test(version)) return failed(`kitshn named no valid release (${version}).`);
  // A daemon run from source has the runtime as its execPath; replacing that would break the runtime.
  if (VERSION === "dev") return failed("This daemon runs from source; update it from the repo.");
  if (version === VERSION) return { ok: true, exitCode: 0, output: `Already at ${version}.` };
  const name = `${releaseAsset(platform, arch())}.gz`;
  const base = `${RELEASES}/edge-${version}`;
  try {
    const sums = await fetch(`${base}/SHA256SUMS`);
    const binary = await fetch(`${base}/${name}`);
    if (!sums.ok || !binary.ok) return failed(`The release edge-${version} has no ${name}.`);
    const expected = expectedHash(await sums.text(), name);
    const packed = new Uint8Array(await binary.arrayBuffer());
    const actual = createHash("sha256").update(packed).digest("hex");
    if (!expected || expected !== actual)
      return failed(`${name} of edge-${version} does not match its SHA256SUMS.`);
    const bytes = gunzipSync(packed);
    const next = `${process.execPath}.new`;
    // A leftover file keeps its old mode, so start fresh and set the mode explicitly.
    rmSync(next, { force: true });
    writeFileSync(next, bytes);
    chmodSync(next, 0o755);
    renameSync(next, process.execPath);
  } catch (error) {
    return failed(`The update failed: ${String(error)}`);
  }
  setTimeout(() => process.exit(0), 500);
  return { ok: true, exitCode: 0, output: `Updated ${VERSION} to ${version}; restarting.` };
}

/** Process groups of running shell jobs. They end with the daemon, also under launchd. */
const runningGroups = new Set<number>();
process.on("exit", () => {
  for (const pid of runningGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

type JobOutcome = { ok: boolean; exitCode: number | null; output: string };

/** Runs a program with a time limit; it gets its own process group, so the limit also ends its children. */
function runProgram(
  program: string,
  args: ReadonlyArray<string>,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<JobOutcome> {
  const timeoutMs = options.timeoutMs ?? JOB_TIMEOUT_MS;
  return new Promise((resolve) => {
    let output = "";
    let done = false;
    const finish = (result: JobOutcome) => {
      if (done) return;
      done = true;
      if (child.pid) runningGroups.delete(child.pid);
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(program, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      cwd: options.cwd,
      env: options.env ?? process.env,
    });
    if (child.pid) runningGroups.add(child.pid);
    // The end of the output holds the error of a failed build, so a long output keeps its end.
    const add = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group is gone already.
        }
      }
      finish({
        ok: false,
        exitCode: null,
        output: `${output}\n[kitshn: the job ran longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped]`,
      });
    }, timeoutMs);
    child.on("close", (code) => finish({ ok: code === 0, exitCode: code, output }));
    child.on("error", (error) => finish({ ok: false, exitCode: null, output: String(error) }));
  });
}

/** A Compose build can take longer than a shell command. */
const COMPOSE_TIMEOUT_MS = 30 * 60_000;
const SOCKET_WAIT_MS = 180_000;

let joined: JoinSecrets | null = null;

/** K-812: a file of the running deploy, read with the machine token. */
async function deployFile(deployId: string, file: string): Promise<Buffer> {
  if (!joined) throw new Error("The daemon has no machine token.");
  const response = await fetch(new URL(`/connect/deploys/${deployId}/${file}`, joined.server), {
    headers: { "CF-Access-Client-Id": joined.clientId, "CF-Access-Client-Secret": joined.clientSecret },
  });
  if (!response.ok)
    throw new Error(`kitshn answered ${response.status} for ${file}: ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}

/** K-1404: the persistent root of KitSHn 1 on this machine. */
const KITSHN1_PERSISTENT = process.env["KITSHN1_PERSISTENT"] ?? "/persistent";

/**
 * K-812, K-607: builds and starts a Compose app with the variables of KitSHn 1, so its `compose.yml` works
 * unchanged: the app listens on `$KITSHN_DEFAULT_SOCKET`. Then the socket becomes a live site under the
 * name of the address, and the tunnel sends the address there.
 */
async function composeUp(
  command: Extract<Command, { kind: "compose" | "compose-redeploy" }>,
): Promise<JobOutcome> {
  const dir = join(paths.data, "apps", command.project);
  // K-818: each deploy unpacks into a new folder that no running container mounts, so the old app runs on
  // while the new one is read, checked and built. A job of the same app never runs at the same time.
  const source = join(dir, `src-${Date.now().toString(36)}`);
  const sockets = join(dir, "sockets");
  const socketPath = join(sockets, "default.sock");
  /** K-818: the configs hold the values of the params, so they stay in a folder of the daemon user only. */
  const scratch = join(dir, "private");
  const checked = join(scratch, "compose.checked.json");
  let output = "";
  /** K-1404: the KitSHn 1 project that this job stopped, which a failure starts again. */
  let stoppedKitshn1: string | null = null;
  /** The volumes that the takeover made, which a failure removes so a retry copies fresh. */
  const madeVolumes: Array<string> = [];
  /** K-818: the containers of the old app that this job stopped, which a failure before `up` starts again. */
  let stoppedIds: Array<string> = [];
  let upStarted = false;
  const step = async (title: string, program: string, args: ReadonlyArray<string>, options = {}) => {
    output += `$ ${title}\n`;
    const result = await runProgram(program, args, { timeoutMs: COMPOSE_TIMEOUT_MS, ...options });
    output += result.output;
    if (!result.ok) throw new Error(`${title} failed with exit code ${result.exitCode ?? "none"}`);
  };
  try {
    mkdirSync(dir, { recursive: true });
    // K-718: the last build that came up stays in good/ with its params; a redeploy starts it again.
    const good = join(dir, "good");
    // A stop in the middle of the swap below leaves only good.old; it is still the last good build.
    if (!existsSync(good) && existsSync(`${good}.old`)) renameSync(`${good}.old`, good);
    if (command.kind === "compose-redeploy") {
      if (!existsSync(join(good, "source.tgz")) || !existsSync(join(good, "params.env")))
        throw new Error("this machine keeps no build of the app that came up; deploy it from the repo");
      copyFileSync(join(good, "source.tgz"), join(dir, "source.tgz"));
      copyFileSync(join(good, "params.env"), join(dir, "params.env"));
      chmodSync(join(dir, "params.env"), 0o600);
    } else {
      writeFileSync(join(dir, "source.tgz"), await deployFile(command.deployId, "source.tgz"));
      writeFileSync(join(dir, "params.env"), await deployFile(command.deployId, "params.env"), { mode: 0o600 });
    }
    mkdirSync(source);
    await step("unpack the source", "tar", ["-xzf", join(dir, "source.tgz"), "-C", source]);
    // K-1404: the first deploy of an app on this machine takes over the data of its KitSHn 1 deployment.
    // KitSHn 1 stops first, so no write lands after the copy; root-owned files need a short container.
    const data = join(dir, "data");
    const marker = join(dir, "kitshn1-taken");
    const takeover =
      command.kind === "compose"
        ? takeoverPlan({
            repo: command.repo,
            environment: command.environment,
            persistentRoot: KITSHN1_PERSISTENT,
            hasData: existsSync(data),
            taken: existsSync(marker),
            exists: existsSync,
          })
        : ({ kind: "skip", note: null } as const);
    if (takeover.kind === "skip" && takeover.note) output += `${takeover.note}\n`;
    const env = {
      ...process.env,
      KITSHN_RECIPE: command.repo,
      KITSHN_ENVIRONMENT: command.environment,
      KITSHN_DEPLOYMENT: command.project,
      KITSHN_SOCKET_DIR: sockets,
      KITSHN_DEFAULT_SOCKET: socketPath,
      KITSHN_DATA_DIR: data,
      KITSHN_LOG_DIR: join(dir, "logs"),
      KITSHN_PARAMS_FILE: join(dir, "params.env"),
    };
    // KitSHn 1 apps join this network; it exists on a KitSHn 1 host and is made elsewhere.
    if (!(await runProgram("docker", ["network", "inspect", "kitshn-edge"])).ok) {
      // Another deploy may make it at the same moment; only a network that is still missing is an error.
      const made = await runProgram("docker", ["network", "create", "kitshn-edge"]);
      if (!made.ok && !(await runProgram("docker", ["network", "inspect", "kitshn-edge"])).ok)
        throw new Error(`docker network create kitshn-edge failed: ${made.output}`);
    }
    // K-818: risky Compose settings run only when the owner allows them for this repo on this machine. The
    // check runs before the takeover, so a refused deploy leaves KitSHn 1 as it is.
    const refuse = (risks: ReadonlyArray<string>) => {
      const refused = risks.filter((risk) => !command.allowed.includes(risk));
      if (refused.length > 0)
        throw new Error(
          `the Compose file asks for ${refused.join(", ")}; the owner allows each one for ${command.repo} in the panel of this machine (K-818)`,
        );
    };
    const real = realpathOnDisk;
    // Explicit files, so a `COMPOSE_FILE` in the params cannot add a file that the check never reads.
    const files = composeFiles(source, command.file, existsSync, real);
    // Before Compose reads the files, so it never fetches what `include` or `extends` names.
    refuse(
      files.flatMap((path) => {
        try {
          return rawRisks(readFileSync(path, "utf8"));
        } catch (error) {
          throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)} (K-818)`);
        }
      }),
    );
    const composeArgs = [
      "compose",
      "-p",
      command.project,
      ...files.flatMap((file) => ["-f", file]),
      "--env-file",
      env.KITSHN_PARAMS_FILE,
    ];
    const roots = [source, data, env.KITSHN_LOG_DIR, sockets] as const;
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    chmodSync(scratch, 0o700);
    const readConfig = async (extra: ReadonlyArray<string>) => {
      const file = join(scratch, "compose.config.json");
      try {
        await step("read the Compose settings", "docker", [...composeArgs, "config", "--format", "json", ...extra, "-o", file], {
          cwd: source,
          env,
        });
        return JSON.parse(readFileSync(file, "utf8")) as unknown;
      } finally {
        rmSync(file, { force: true });
      }
    };
    // Without the params first, so an error in the files does not show their values.
    // It names the env and label files without reading them; the run with the params reads them.
    refuse(envFileRisks(await readConfig(["--no-interpolate"]), roots, real));
    const config = await readConfig([]);
    refuse(composeRisks(config, command.project, roots, real));
    if (takeover.kind === "take") {
      // Set first: a stop that fails half-way still gets its start back.
      stoppedKitshn1 = takeover.project;
      await step("stop the KitSHn 1 app", "docker", ["compose", "-p", takeover.project, "stop"], { cwd: paths.data });
      // A staged copy becomes the data folder only when it is complete.
      const staged = `${data}.kitshn1`;
      output += await removeAsRoot(staged, `${command.project}-stage`);
      mkdirSync(staged, { recursive: true });
      await step("copy the KitSHn 1 data", "docker", [
        "run", "--rm", "--network", "none", "-v", `${takeover.dataDir}:/from:ro`, "-v", `${staged}:/to`,
        HELPER_IMAGE, "cp", "-a", "/from/.", "/to/",
      ]);
      const volumes = await runProgram("docker", [
        "volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${takeover.project}`,
      ]);
      if (!volumes.ok) throw new Error(`docker volume ls failed: ${volumes.output}`);
      for (const volume of volumes.output.split("\n").map((line) => line.trim()).filter(Boolean)) {
        const target = movedVolume(volume, takeover.project, command.project);
        if (!target) continue;
        const suffix = target.slice(command.project.length + 1);
        madeVolumes.push(target);
        await step(`create the volume ${target}`, "docker", [
          "volume", "create",
          "--label", `com.docker.compose.project=${command.project}`,
          "--label", `com.docker.compose.volume=${suffix}`,
          target,
        ]);
        await step(`copy the volume ${volume}`, "docker", [
          "run", "--rm", "--network", "none", "-v", `${volume}:/from:ro`, "-v", `${target}:/to`,
          HELPER_IMAGE, "cp", "-a", "/from/.", "/to/",
        ]);
      }
      renameSync(staged, data);
      writeFileSync(marker, `${takeover.dataDir}\n`);
      output += `KitSHn 1 data of ${takeover.project} copied from ${takeover.dataDir}; it stays there for a rollback.\n`;
      output += `KitSHn 1 is stopped, so the site is down until you move the DNS record of ${command.name} to the tunnel (K-1404).\n`;
    }
    // The container user may not be the daemon user; the socket directory must take its socket.
    mkdirSync(sockets, { recursive: true });
    chmodSync(sockets, 0o777);
    for (const folder of [data, env.KITSHN_LOG_DIR]) mkdirSync(folder, { recursive: true });
    // Build and start from the checked config itself, so the repo's files are not read again. It stays with
    // the last good build, so a teardown reads the same services.
    writeFileSync(checked, JSON.stringify(config), { mode: 0o600 });
    // The params file again: without it Compose reads the repo's `.env`, and `COMPOSE_PROFILES` is lost.
    const run = [
      "compose",
      "-p",
      command.project,
      "--project-directory",
      source,
      "-f",
      checked,
      "--env-file",
      env.KITSHN_PARAMS_FILE,
    ];
    await step("docker compose build", "nice", ["-n", "19", "docker", ...run, "build"], { cwd: source, env });
    // K-818: no container of the app runs from here to `up`, so none can swap a path in the data, log or
    // sockets folder between the check below and `up`. Orphans and one-off runs count too.
    const running = await runProgram("docker", ["ps", "-q", "--filter", `label=com.docker.compose.project=${command.project}`]);
    if (!running.ok) throw new Error(`docker ps failed: ${running.output}`);
    const ids = running.output.split("\n").map((id) => id.trim()).filter(Boolean);
    // Set first: a stop that fails half-way still gets its start back.
    stoppedIds = ids;
    if (ids.length > 0) await step("stop the app", "docker", ["stop", ...ids]);
    // The takeover may also have brought links into the data folder.
    const moved = sourceRisks(config, roots, real).filter((risk) => !command.allowed.includes(risk));
    if (moved.length > 0) throw new Error(`a path changed after the check: ${moved.join(", ")} (K-818)`);
    // A teardown takes down what the last `up` started, also when that `up` failed.
    copyFileSync(checked, join(scratch, "down.json"));
    copyFileSync(env.KITSHN_PARAMS_FILE, join(scratch, "down.env"));
    upStarted = true;
    await step("docker compose up", "docker", [...run, "up", "-d", "--no-build", "--remove-orphans"], { cwd: source, env });
    const until = Date.now() + SOCKET_WAIT_MS;
    while (!(await probe(`unix:${socketPath}`))) {
      if (Date.now() > until) throw new Error(`the app opened no socket at ${socketPath} within 3 minutes`);
      await new Promise((done) => setTimeout(done, 2000));
    }
    const sites = readSites();
    if (sites === null) throw new Error(`${sitesFile()} is broken; fix it, then deploy again`);
    const next = addSite(sites, { name: command.name, target: `unix:${socketPath}`, dev: false });
    if (typeof next === "string") throw new Error(next);
    writeSites(next);
    void checkSites();
    // The build and its params change together: a stop in between leaves the old pair, the new pair or none.
    const staged = join(dir, "good.next");
    rmSync(staged, { recursive: true, force: true });
    mkdirSync(staged, { mode: 0o700 });
    renameSync(join(dir, "source.tgz"), join(staged, "source.tgz"));
    copyFileSync(join(dir, "params.env"), join(staged, "params.env"));
    chmodSync(join(staged, "params.env"), 0o600);
    rmSync(checked, { force: true });
    rmSync(`${good}.old`, { recursive: true, force: true });
    if (existsSync(good)) renameSync(good, `${good}.old`);
    renameSync(staged, good);
    rmSync(`${good}.old`, { recursive: true, force: true });
    // The containers of the last build may have written into their source as root (a bind mount of `.`).
    // A folder that stays costs disk only; the app is up, so the deploy still succeeds.
    for (const old of sourceFolders(dir).filter((folder) => folder !== source))
      output += await removeAsRoot(old, `${command.project}-${basename(old)}`).catch(
        (cleanup: unknown) => `${String(cleanup)}\n`,
      );
    output += `\nThe app answers on its socket; the tunnel sends ${command.name} there.\n`;
    return { ok: true, exitCode: 0, output };
  } catch (error) {
    output += `\n[kitshn: ${error instanceof Error ? error.message : String(error)}]`;
    rmSync(checked, { force: true });
    // K-818: before `up`, the old containers and their source are as they were, so the old app runs again.
    // After `up` started, Compose replaced them; the app stays down until a deploy or redeploy comes up.
    if (!upStarted) {
      if (stoppedIds.length > 0) {
        const started = await runProgram("docker", ["start", ...stoppedIds]);
        output += `$ start the app again\n${started.output}`;
      }
      output += await removeAsRoot(source, `${command.project}-${basename(source)}`).catch(
        (cleanup: unknown) => `${String(cleanup)}\n`,
      );
    }
    // A takeover that did not end in a running app gives the site back to KitSHn 1, and the next deploy
    // copies its data again, so no write of KitSHn 1 is lost.
    if (stoppedKitshn1 !== null) {
      // By its project label alone; the app's folder holds no Compose file.
      await runProgram("docker", ["compose", "-p", command.project, "down"], { cwd: dir });
      rmSync(join(dir, "kitshn1-taken"), { force: true });
      for (const folder of ["data", "data.kitshn1"])
        output += await removeAsRoot(join(dir, folder), `${command.project}-${folder.replace(".", "-")}`).catch(
          (cleanup: unknown) => `${String(cleanup)}\n`,
        );
      for (const volume of madeVolumes) output += (await runProgram("docker", ["volume", "rm", volume])).output;
      const started = await runProgram("docker", ["compose", "-p", stoppedKitshn1, "start"], { cwd: paths.data });
      output += `$ start the KitSHn 1 app ${stoppedKitshn1} again\n${started.output}`;
    }
    return { ok: false, exitCode: null, output };
  }
}

/** Short root jobs on app folders (copy, clean-up); busybox has `cp -a` and `find -delete` and is a few MB. */
// Pinned by digest, so no app can take the name with an image of its own (K-818).
const HELPER_IMAGE = "busybox:1.38@sha256:fd7dc98638c8e305f4dc34e979f1c0fdfdcaeb0fbf8fcff77ae834b6da3d7e6e";
/** K-818: the source folders of an app: the one of its last deploy, and any of a deploy that failed in `up`. */
const sourceFolders = (dir: string): Array<string> =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name === "src" || name.startsWith("src-"))
        .sort()
        .map((name) => join(dir, name))
    : [];

/**
 * Removes a folder that an app's containers wrote into, often as root, which the daemon user cannot remove.
 * A short container with the same folder deletes what is inside; nothing widens the permissions of files.
 * Returns the output, or throws when the folder stays.
 */
async function removeAsRoot(dir: string, name: string): Promise<string> {
  if (!existsSync(dir)) return "";
  const inside = await runProgram(
    "docker",
    ["run", "--rm", "--name", `kitshn-clean-${name}`, "--network", "none", "-v", `${dir}:/app`, HELPER_IMAGE, "find", "/app", "-mindepth", "1", "-delete"],
    { timeoutMs: COMPOSE_TIMEOUT_MS },
  );
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`${dir} stays: ${error instanceof Error ? error.message : String(error)}\n${inside.output}`);
  }
  return `$ remove ${dir}\n${inside.output}`;
}

/** K-904: stops the app, stops exposing it, and for a preview removes its volumes and files. */
async function composeDown(command: Extract<Command, { kind: "compose-down" }>): Promise<JobOutcome> {
  const sites = readSites();
  if (sites) writeSites(sites.filter((site) => site.name !== command.name));
  void checkSites();
  const dir = join(paths.data, "apps", command.project);
  // K-818: the checked config of the last `up` names the same services and profiles; the repo's own files
  // are never read. Without one, Compose finds the app by its project label alone.
  const last = [join(dir, "private", "down.json"), join(dir, "private", "down.env")] as const;
  const files = last.every((file) => existsSync(file)) ? ["-f", last[0], "--env-file", last[1]] : [];
  const result = await runProgram(
    "docker",
    [
      "compose",
      "-p",
      command.project,
      ...files,
      "down",
      "--remove-orphans",
      ...(command.removeData ? ["--volumes", "--rmi", "local"] : []),
    ],
    // The app's folder holds no Compose file, so Compose reads none of the repo's files.
    { timeoutMs: COMPOSE_TIMEOUT_MS, cwd: existsSync(dir) ? dir : paths.data },
  );
  // Containers that may still run could write while the files go, so a failed down keeps them for a retry.
  if (!command.removeData || !result.ok) return result;
  // Also the volumes that no kept config names, such as those of an earlier build.
  const volumes = await runProgram("docker", ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${command.project}`]);
  const names = volumes.output.split("\n").map((name) => name.trim()).filter(Boolean);
  const removed = volumes.ok && names.length > 0 ? await runProgram("docker", ["volume", "rm", ...names]) : volumes;
  const output = `${result.output}${removed.output}`;
  if (!removed.ok) return { ok: false, exitCode: removed.exitCode, output };
  try {
    return { ...result, output: output + (await removeAsRoot(dir, command.project)) };
  } catch (error) {
    return { ok: false, exitCode: null, output: `${output}\n[kitshn: ${error instanceof Error ? error.message : String(error)}]` };
  }
}

/**
 * K-909: the idle volumes of kitshn apps, read from Docker; null when Docker does not answer. Known limit:
 * runProgram keeps the last 64 KiB of output, which cuts the list at about a thousand volumes. Revisit then.
 */
async function readIdleVolumes(): Promise<Array<ProjectVolume> | null> {
  const volumes = await runProgram("docker", ["volume", "ls", "--format", VOLUME_FORMAT]);
  const running = await runProgram("docker", ["ps", "--format", RUNNING_FORMAT]);
  if (!volumes.ok || !running.ok) return null;
  const apps = join(paths.data, "apps");
  return idleVolumes(volumes.output, running.output, existsSync(apps) ? readdirSync(apps) : []);
}

/** K-909: tells kitshn the idle volumes, so the machine card lists the orphaned ones. */
async function reportVolumes() {
  const volumes = await readIdleVolumes();
  if (volumes === null || socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "volumes", volumes } satisfies DaemonMessage));
}

/** K-909: deletes one volume, only while it is still an idle volume of that kitshn app. */
async function removeVolume(command: Extract<Command, { kind: "compose-volume-remove" }>): Promise<JobOutcome> {
  const idle = await readIdleVolumes();
  if (idle === null) return { ok: false, exitCode: null, output: "Docker does not answer, so the volume stays." };
  const refusal = volumeRemoveRefusal(idle, command);
  if (refusal !== null) return { ok: false, exitCode: null, output: refusal };
  return runProgram("docker", ["volume", "rm", command.volume]);
}

/** One Compose job per app at a time: a teardown never runs during the build of the same app. */
const appQueues = new Map<string, Promise<unknown>>();
function oneAtATime(project: string, work: () => Promise<JobOutcome>): Promise<JobOutcome> {
  const next = (appQueues.get(project) ?? Promise.resolve()).then(work, work);
  appQueues.set(project, next);
  return next;
}

function runJob(command: Command): Promise<JobOutcome> {
  if (command.kind === "compose" || command.kind === "compose-redeploy")
    return oneAtATime(command.project, () => composeUp(command));
  if (command.kind === "compose-down") return oneAtATime(command.project, () => composeDown(command));
  if (command.kind === "compose-volume-remove") return oneAtATime(command.project, () => removeVolume(command));
  if (command.kind === "diagnostics") {
    const text = [
      `kitshn ${VERSION}`,
      `machine ${hostname()} ${osPlatform()} ${release()} ${arch()}`,
      `uptime ${Math.round(uptime() / 60)} minutes`,
      `config ${paths.config}`,
      `data ${paths.data}`,
      `cloudflared ${tunnelState}`,
    ].join("\n");
    return Promise.resolve({ ok: true, exitCode: 0, output: text });
  }
  if (command.kind === "update") return updateDaemon(command.version);
  if (command.kind === "restart") {
    // The service manager starts the daemon again after this exit.
    setTimeout(() => process.exit(0), 500);
    return Promise.resolve({ ok: true, exitCode: 0, output: "restarting" });
  }
  // `$KITSHN` is this daemon's binary, so a job can run `"$KITSHN" expose …` (K-1104).
  // From source, execPath is bun itself, not kitshn.
  return runProgram("/bin/sh", ["-c", command.script], {
    env: VERSION === "dev" ? process.env : { ...process.env, KITSHN: process.execPath },
  });
}

let tunnelState: "starting" | "running" | "stopped" = "stopped";
let socket: WebSocket | null = null;

function report() {
  const message: DaemonMessage = {
    type: "status",
    status: {
      capabilities: ["update", "update-gz", "compose", "compose-redeploy", "compose-guard"],
      version: VERSION,
      os: `${osPlatform()} ${release()}`,
      arch: arch(),
      hostname: hostname(),
      tunnel: tunnelState,
    },
  };
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

/** K-605: the tunnel state comes from its service manager; a change goes out in the status. */
function watchTunnel() {
  const check = () => {
    const [program = "", ...rest] = tunnel.state;
    const result = spawnSync(program, rest, { encoding: "utf8" });
    const state = tunnelStateOf(platform, result.stdout ?? "");
    if (state === tunnelState) return;
    tunnelState = state;
    report();
  };
  check();
  setInterval(check, 5000);
}

const pendingResults: Array<DaemonMessage> = [];

function flushResults() {
  while (socket?.readyState === WebSocket.OPEN && pendingResults.length > 0) {
    socket.send(JSON.stringify(pendingResults.shift()));
  }
}

/** K-1704: the challenge of the accepted connection; a rotation signs it too (K-1705). */
let challenge: string | null = null;
let rotating = false;

/**
 * K-1704: signs the challenge with the key that kitshn names. Returns "answered", "token-only" when kitshn has
 * no key for this machine (K-1708: status only, no jobs, until `kitshn rekey`), or why this key cannot pass.
 */
async function answerChallenge(
  ws: WebSocket,
  config: JoinSecrets,
  message: Extract<ServerToDaemon, { type: "challenge" }>,
): Promise<"answered" | "wrong-key" | "no-key" | "token-only"> {
  const fingerprint = async (file: string) => {
    const key = readKey(file);
    return key ? fingerprintOf(key.x) : null;
  };
  const plan = keyPlan(message.fingerprint, {
    current: await fingerprint(keyFile),
    next: await fingerprint(nextKeyFile),
    fromCode: await fingerprint(codeKeyFile),
  });
  // kitshn took the key, but the end of its command or the 4004 close never came (K-1705, K-1706).
  if (plan.promote === "fromCode") renameSync(codeKeyFile, keyFile);
  if (plan.promote === "next") renameSync(nextKeyFile, keyFile);
  // A rotation that kitshn never took; a new "Rotate key" or `kitshn rotate-key` asks again.
  if (plan.dropNext) rmSync(nextKeyFile, { force: true });
  if (message.fingerprint === null) {
    log("kitshn has no key for this machine, so it gets status only and no job. Run kitshn rekey with the key code of its panel.");
    return "token-only";
  }
  const key = readKey(keyFile);
  if (!key) {
    log(`kitshn expects the key ${message.fingerprint}, and ${keyFile} is missing. Use Reset key on the map, then kitshn rekey <code>.`);
    return "no-key";
  }
  const signing = await fingerprintOf(key.x);
  const signature = await signText(key, connectText(config.server, config.machineId, message.challenge));
  ws.send(JSON.stringify({ type: "answer", signature } satisfies DaemonMessage));
  challenge = message.challenge;
  if (message.fingerprint === signing) return "answered";
  log(`kitshn expects the key ${message.fingerprint}, but this machine has ${signing}. Use Reset key on the map, then kitshn rekey <code>.`);
  return "wrong-key";
}

type RotationOutcome = { readonly fingerprint: string } | { readonly error: string };
/** K-1705: the `rotate-key` requests of the local socket that wait for kitshn to store the new key. */
const rotationWaiters: Array<(outcome: RotationOutcome) => void> = [];
const settleRotation = (outcome: RotationOutcome) => {
  for (const waiter of rotationWaiters.splice(0)) waiter(outcome);
};
/** The fingerprint of the key that the current connection rotates to. */
let rotatingTo: string | null = null;

/** K-1705: makes a new pair and hands over to it with a signature of the old key, bound to this connection. */
async function rotateKey(ws: WebSocket) {
  if (rotating || challenge === null || socket !== ws || !joined) return;
  const current = readKey(keyFile);
  if (!current) {
    log(`no key to rotate in ${keyFile}`);
    return settleRotation({ error: `there is no key to rotate in ${keyFile}.` });
  }
  rotating = true;
  let next: MachinePrivateKey;
  let signature: string;
  try {
    next = await newMachineKey();
    writeKey(nextKeyFile, next);
    signature = await signText(current, rotateText(joined.server, joined.machineId, challenge, next.x));
  } catch (error) {
    // Nothing went out yet, so kitshn has no new key.
    rotating = false;
    rmSync(nextKeyFile, { force: true });
    log(`the key rotation failed: ${String(error)}`);
    return settleRotation({ error: `the key rotation failed: ${String(error)}` });
  }
  rotatingTo = await fingerprintOf(next.x);
  // From here kitshn may store the new key, so `machine.key.next` stays until the next challenge names a key.
  ws.send(JSON.stringify({ type: "rotate", publicKey: next.x, signature } satisfies DaemonMessage));
  log(`rotating the machine key to ${rotatingTo}`);
}

/** K-1706, K-1708: ends the current connection or wait and connects again at once, for `kitshn rekey`. */
let reconnectNow = () => {};

/** K-604: one WebSocket to kitshn, with backoff after a failure and a ping every 10 seconds. */
function connect(config: JoinSecrets) {
  joined = config;
  let delay = 1000;
  // After a 4001, 4002 or 4005 close, or a key that cannot pass, every later try waits an hour, until a
  // connection opens again.
  let stopped = false;
  let current: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let soon = false;
  reconnectNow = () => {
    stopped = false;
    delay = 1000;
    if (current) {
      soon = true;
      current.close();
    } else {
      if (timer) clearTimeout(timer);
      open();
    }
  };
  const open = () => {
    timer = null;
    const url = new URL("/connect", config.server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url.toString(), {
      headers: { "CF-Access-Client-Id": config.clientId, "CF-Access-Client-Secret": config.clientSecret },
    } as unknown as string);
    current = ws;
    let lastPong = Date.now();
    let ping: ReturnType<typeof setInterval> | null = null;
    /** True when kitshn expects a key that this machine does not have, so the next try fails the same way. */
    let wrongKey = false;
    ws.onopen = () => {
      lastPong = Date.now();
      ping = setInterval(() => {
        if (Date.now() - lastPong > PONG_TIMEOUT_MS) {
          log("no pong for 30 s; connecting again");
          ws.close();
          return;
        }
        ws.send("ping");
      }, PING_MS);
    };
    /** K-1704: kitshn reads this connection from now on. */
    const accepted = (how: string) => {
      log(`connected to kitshn ${how}`);
      socket = ws;
      delay = 1000;
      stopped = false;
      flushResults();
      report();
      lastSites = "";
      void checkSites().catch((error: unknown) => log(`site check failed: ${String(error)}`));
      void reportVolumes().catch((error: unknown) => log(`volume report failed: ${String(error)}`));
      ws.send(JSON.stringify({ type: "sample", sample: sample() } satisfies DaemonMessage));
    };
    ws.onmessage = (event) => {
      const text = String(event.data);
      if (text === "pong") {
        lastPong = Date.now();
        return;
      }
      const message = JSON.parse(text) as ServerToDaemon;
      if (message.type === "challenge") {
        void answerChallenge(ws, config, message)
          .then((result) => {
            wrongKey = result === "wrong-key" || result === "no-key";
            if (result === "no-key") ws.close();
            if (result === "token-only") accepted("on the token alone");
          })
          .catch((error: unknown) => {
            log(`could not answer the challenge: ${String(error)}`);
            ws.close();
          });
      } else if (message.type === "accepted") {
        accepted(`with the key ${message.fingerprint}`);
      } else if (message.type === "rotateKey") {
        void rotateKey(ws);
      } else if (message.type === "job") {
        log(`job ${message.id}: ${message.command.kind}`);
        // A job that throws (for example a file it cannot delete) still sends a result, and never ends the daemon.
        void runJob(message.command)
          .catch((error: unknown): JobOutcome => ({
            ok: false,
            exitCode: null,
            output: `[kitshn: ${String(error)}]`,
          }))
          .then((result) => {
            // The connection can change while a job runs; the result goes out on the current one.
            pendingResults.push({ type: "jobResult", id: message.id, result });
            flushResults();
            // K-909: a Compose job can leave volumes idle or take them away.
            if (message.command.kind.startsWith("compose"))
              void reportVolumes().catch((error: unknown) => log(`volume report failed: ${String(error)}`));
          });
      }
    };
    ws.onclose = (event) => {
      if (ping) clearInterval(ping);
      if (socket === ws) socket = null;
      // K-1705: kitshn stored the new key; the next connection signs with it.
      if (event.code === 4004 && existsSync(nextKeyFile)) renameSync(nextKeyFile, keyFile);
      settleRotation(
        event.code === 4004 && rotatingTo !== null
          ? { fingerprint: rotatingTo }
          : { error: `the connection closed (${event.code}) before kitshn stored the new key. See kitshn status.` },
      );
      challenge = null;
      rotating = false;
      rotatingTo = null;
      // 4001: another daemon with the same token took over; 4002: the owner removed this machine; 4005: the
      // owner reset its key. Like a key that cannot pass, they would repeat forever with a short backoff, so
      // they wait long (a removed machine also needs a new join, a reset one `kitshn rekey`).
      if (event.code === 4001 || event.code === 4002 || event.code === 4005 || wrongKey) stopped = true;
      // K-615: kitshn deleted the tunnel of this machine; its service has nothing left to serve.
      if (event.code === 4002) {
        log("the owner removed this machine; removing the tunnel service. Run kitshn service uninstall to stop the daemon.");
        removeTunnel();
      }
      if (current === ws) current = null;
      const wait = soon || event.code === 4004 ? 0 : stopped ? 60 * 60_000 : delay;
      soon = false;
      log(`connection closed (${event.code} ${event.reason}); trying again in ${wait / 1000} s`);
      timer = setTimeout(open, wait);
      delay = Math.min(delay * 2, 60_000);
    };
    ws.onerror = () => ws.close();
  };
  open();
}

const sitesFile = () => join(paths.data, "sites.json");

/** The sites of this machine, or null when `sites.json` is broken. */
function readSites(): Array<SiteEntry> | null {
  if (!existsSync(sitesFile())) return [];
  try {
    return parseSiteFile(JSON.parse(readFileSync(sitesFile(), "utf8")));
  } catch {
    return null;
  }
}

/** Writes `sites.json` through a rename, so the daemon never reads half a file. */
function writeSites(sites: ReadonlyArray<SiteEntry>) {
  mkdirSync(paths.data, { recursive: true });
  const temporary = `${sitesFile()}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(sites, null, 2)}\n`);
  renameSync(temporary, sitesFile());
}

/** K-1104: `kitshn expose <port or socket> --name <name> [--dev]`. The running daemon picks it up. */
function exposeCommand(value: string | undefined, name: string | undefined, dev: boolean) {
  const target = value ? targetOf(value) : null;
  if (!target || !name) fail("usage: kitshn expose <port or /path/to.sock> --name <name> [--dev]");
  const current = readSites();
  if (current === null) fail(`${sitesFile()} is broken. Fix it or delete it, then expose the sites again.`);
  const sites = addSite(current!, { name: name!, target: target!, dev });
  if (typeof sites === "string") fail(sites);
  writeSites(sites as Array<SiteEntry>);
  console.log(
    `Exposed ${target} as ${name}. Its card arrives in the tray of the map, private until you share it.`,
  );
}

function unexposeCommand(name: string | undefined) {
  const sites = readSites();
  if (sites === null) fail(`${sitesFile()} is broken. Fix it or delete it.`);
  if (!name || !sites!.some((site) => site.name === name)) fail(`no live site is named ${name ?? "(none)"}.`);
  writeSites(sites!.filter((site) => site.name !== name));
  console.log(`Stopped exposing ${name}.`);
}

let lastSites = "";

/** K-1107: tries each site every 10 seconds and reports the list only when it changes. */
async function checkSites() {
  // A broken file must not look like "no sites": that would remove every card and its shares on the map.
  const sites = readSites();
  if (sites === null) {
    log(`${sitesFile()} is broken; kitshn keeps the last report until it is fixed.`);
    return;
  }
  const reports = await Promise.all(sites.map(async (site) => ({ ...site, up: await probe(site.target) })));
  const text = JSON.stringify({ type: "sites", sites: reports } satisfies DaemonMessage);
  if (text === lastSites || socket?.readyState !== WebSocket.OPEN) return;
  lastSites = text;
  socket.send(text);
}

async function runCommand() {
  const config = readConfig();
  log(`kitshn ${VERSION} starts as machine ${config.machineId}`);
  // First, so a second daemon stops before it touches the tunnel or the connection of the running one.
  const own = process.getuid!();
  const local = await listenLocal(paths.socket, {
    platform,
    // Read at each connection, so `kitshn local-users` needs no restart.
    decide: (peer) => peerDecision(peer, own, localUsersOf(readMachineFile())),
    handle: answerLocal,
    log,
  });
  process.on("exit", local.stop);
  // The service manager stops the daemon with SIGTERM; an exit runs the clean-up of the socket and the jobs.
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => process.exit(0));
  pruneSamples();
  await ensureTunnel(config);
  watchTunnel();
  connect(config);
  setInterval(() => {
    const value = sample();
    keepSample(value);
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: "sample", sample: value } satisfies DaemonMessage));
  }, SAMPLE_MS);
  setInterval(pruneSamples, 24 * 60 * 60_000);
  setInterval(
    () => void checkSites().catch((error: unknown) => log(`site check failed: ${String(error)}`)),
    10_000,
  );
}

/** `machine.json` as it is on disk now, or null when it cannot be read. */
function readMachineFile(): unknown {
  try {
    return JSON.parse(readFileSync(paths.config, "utf8"));
  } catch {
    return null;
  }
}

/** K-701, K-702: the requests of the local socket. */
async function answerLocal(request: Request): Promise<Answer> {
  const { id } = request;
  if (request.type === "status") {
    if (!joined) throw new Error("the daemon has not read machine.json yet.");
    const key = readKey(keyFile);
    return {
      id,
      type: "status",
      status: {
        version: VERSION,
        machineId: joined.machineId,
        fingerprint: key ? await fingerprintOf(key.x) : null,
        connection: socket === null ? "disconnected" : challenge === null ? "token-only" : "connected",
        tunnel: tunnelState,
      },
    };
  }
  if (request.type === "reconnect") {
    log("kitshn rekey saved a new key; connecting again");
    reconnectNow();
    return { id, type: "reconnect" };
  }
  const ws = socket;
  if (ws === null || challenge === null)
    throw new Error("the daemon has no signed connection to kitshn, and a rotation needs one (K-1705). See kitshn status.");
  const outcome = await new Promise<RotationOutcome>((resolve) => {
    rotationWaiters.push(resolve);
    void rotateKey(ws);
  });
  if ("error" in outcome) throw new Error(outcome.error);
  return { id, type: "rotate-key", fingerprint: outcome.fingerprint };
}

const [command, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

switch (command) {
  case "join":
    await joinCommand(args[0], flag("--server"));
    break;
  case "run":
    await runCommand();
    break;
  case "service":
    await serviceCommand(args[0]);
    break;
  case "rotate-key":
    await rotateKeyCommand();
    break;
  case "rekey":
    await rekeyCommand(args[0]);
    break;
  case "status":
    await statusCommand();
    break;
  case "local-users":
    localUsersCommand(args[0], args[1]);
    break;
  case "version":
    console.log(VERSION);
    break;
  case "expose":
    exposeCommand(args[0], flag("--name"), args.includes("--dev"));
    break;
  case "unexpose":
    unexposeCommand(args[0]);
    break;
  default:
    console.log(`kitshn ${VERSION}

kitshn join <code> --server <address>   join this machine to kitshn (K-602)
kitshn service install                  run the daemon as a user service (K-601)
kitshn service uninstall                stop and remove the user service
kitshn run                              run the daemon in the foreground
kitshn rotate-key                       replace the machine key over the live connection (K-1705)
kitshn rekey <code>                     make a new machine key with the key code of its panel (K-1706, K-1708)
kitshn status                           the machine, its key, its connection to kitshn and its tunnel
kitshn local-users list|add|remove <u>  who else may use the local socket, as the daemon user (K-701)
kitshn expose <port|socket> --name <n>  share a local server at <n>.<zone> (K-1104); --dev sets Host localhost
kitshn unexpose <name>                  stop sharing it
kitshn version`);
}
