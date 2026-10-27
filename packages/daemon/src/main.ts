// The kitshn daemon (SPEC section 6). One program: `kitshn join`, `kitshn run`, `kitshn service`.
import {
  openJoin,
  type Command,
  type DaemonMessage,
  type JoinSecrets,
  type ServerToDaemon,
} from "@kitshn/edge/machine";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { kitshn1Deployment } from "./kitshn1.ts";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
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
import { dirname, join } from "node:path";
import {
  type Platform,
  RELEASES,
  cloudflaredUrl,
  expectedHash,
  pathsFor,
  releaseAsset,
  serviceCommands,
  serviceFile,
} from "./service.ts";
import { type SiteEntry, addSite, parseSiteFile, probe, targetOf } from "./sites.ts";

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

/** K-602: trades the join code for the machine secrets and saves them for the daemon user only. */
async function joinCommand(code: string | undefined, server: string | undefined) {
  if (!code || !server) fail("usage: kitshn join <code> --server https://kit.example.com");
  const response = await fetch(new URL("/join/exchange", server), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const body = (await response.json().catch(() => null)) as {
    iv?: string;
    sealed?: string;
    error?: string;
  } | null;
  if (!response.ok || !body?.iv || !body.sealed)
    fail(body?.error ?? `the server answered ${response.status}.`);
  const secrets = await openJoin(code, { iv: body.iv, sealed: body.sealed });
  mkdirSync(dirname(paths.config), { recursive: true, mode: 0o700 });
  // An older file can have looser permissions; tighten them before the secrets go in.
  if (existsSync(paths.config)) chmodSync(paths.config, 0o600);
  writeFileSync(paths.config, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  console.log(`Joined as machine ${secrets.machineId}. Saved the tokens in ${paths.config}.`);
}

function serviceCommand(action: string | undefined) {
  const file = paths.service;
  const commands = serviceCommands(platform, file, process.getuid?.() ?? 0);
  const run = (argv: Array<string>, mayFail = false) => {
    const [program = "", ...rest] = argv;
    const result = spawnSync(program, rest, { stdio: "inherit" });
    if (result.status !== 0 && !mayFail) fail(`${argv.join(" ")} failed.`);
  };
  if (action === "install") {
    readConfig();
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
    console.log(
      `Removed ${file}. The tokens stay in ${paths.config}; delete them with: rm -r "${dirname(paths.config)}"`,
    );
  } else fail("usage: kitshn service install|uninstall");
}

/** K-603: the daemon runs its own cloudflared, downloaded once, with the tunnel token in its environment. */
async function ensureCloudflared(): Promise<string> {
  const file = join(paths.data, "cloudflared");
  if (existsSync(file)) return file;
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
  return file;
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
/** Short root jobs on app folders (copy, clean-up); busybox has `cp -a` and `find -delete` and is a few MB. */
const HELPER_IMAGE = "busybox:1.38";

/**
 * K-812, K-607: builds and starts a Compose app with the variables of KitSHn 1, so its `compose.yml` works
 * unchanged: the app listens on `$KITSHN_DEFAULT_SOCKET`. Then the socket becomes a live site under the
 * name of the address, and the tunnel sends the address there.
 */
async function composeUp(
  command: Extract<Command, { kind: "compose" | "compose-redeploy" }>,
): Promise<JobOutcome> {
  const dir = join(paths.data, "apps", command.project);
  const source = join(dir, "src");
  const sockets = join(dir, "sockets");
  const socketPath = join(sockets, "default.sock");
  let output = "";
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
    // The last build's containers may have written into the source as root (a bind mount of `.`).
    output += await removeAsRoot(source, `${command.project}-src`);
    mkdirSync(source, { recursive: true });
    await step("unpack the source", "tar", ["-xzf", join(dir, "source.tgz"), "-C", source]);
    // K-1404: the first deploy of an app on this machine takes over the data of its KitSHn 1 deployment.
    // KitSHn 1 stops first, so no write lands after the copy; root-owned files need a short container.
    const data = join(dir, "data");
    const old = kitshn1Deployment(command.repo, command.environment, KITSHN1_PERSISTENT);
    if (command.kind === "compose" && !existsSync(data) && old && existsSync(old.dataDir)) {
      await step("stop the KitSHn 1 app", "docker", ["compose", "-p", old.project, "stop"], { cwd: paths.data });
      mkdirSync(data, { recursive: true });
      await step("copy the KitSHn 1 data", "docker", [
        "run",
        "--rm",
        "-v",
        `${old.dataDir}:/from:ro`,
        "-v",
        `${data}:/to`,
        HELPER_IMAGE,
        "cp",
        "-a",
        "/from/.",
        "/to/",
      ]);
      output += `KitSHn 1 data of ${old.project} copied from ${old.dataDir}; it stays there for a rollback.\n`;
    }
    // The container user may not be the daemon user; the socket directory must take its socket.
    mkdirSync(sockets, { recursive: true });
    chmodSync(sockets, 0o777);
    const env = {
      ...process.env,
      KITSHN_RECIPE: command.repo,
      KITSHN_ENVIRONMENT: command.environment,
      KITSHN_DEPLOYMENT: command.project,
      KITSHN_SOCKET_DIR: sockets,
      KITSHN_DEFAULT_SOCKET: socketPath,
      KITSHN_DATA_DIR: join(dir, "data"),
      KITSHN_LOG_DIR: join(dir, "logs"),
      KITSHN_PARAMS_FILE: join(dir, "params.env"),
    };
    for (const folder of [env.KITSHN_DATA_DIR, env.KITSHN_LOG_DIR]) mkdirSync(folder, { recursive: true });
    // KitSHn 1 apps join this network; it exists on a KitSHn 1 host and is made elsewhere.
    if (!(await runProgram("docker", ["network", "inspect", "kitshn-edge"])).ok) {
      // Another deploy may make it at the same moment; only a network that is still missing is an error.
      const made = await runProgram("docker", ["network", "create", "kitshn-edge"]);
      if (!made.ok && !(await runProgram("docker", ["network", "inspect", "kitshn-edge"])).ok)
        throw new Error(`docker network create kitshn-edge failed: ${made.output}`);
    }
    await step(
      "docker compose up",
      "nice",
      [
        "-n",
        "19",
        "docker",
        "compose",
        "-p",
        command.project,
        ...(command.file ? ["-f", command.file] : []),
        "--env-file",
        join(dir, "params.env"),
        "up",
        "-d",
        "--build",
        "--remove-orphans",
      ],
      { cwd: source, env },
    );
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
    rmSync(`${good}.old`, { recursive: true, force: true });
    if (existsSync(good)) renameSync(good, `${good}.old`);
    renameSync(staged, good);
    rmSync(`${good}.old`, { recursive: true, force: true });
    output += `\nThe app answers on its socket; the tunnel sends ${command.name} there.\n`;
    return { ok: true, exitCode: 0, output };
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      output: `${output}\n[kitshn: ${error instanceof Error ? error.message : String(error)}]`,
    };
  }
}

/** Short root jobs on app folders (copy, clean-up); busybox has `cp -a` and `find -delete` and is a few MB. */
const HELPER_IMAGE = "busybox:1.38";

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
  const result = await runProgram(
    "docker",
    [
      "compose",
      "-p",
      command.project,
      "down",
      "--remove-orphans",
      ...(command.removeData ? ["--volumes", "--rmi", "local"] : []),
    ],
    // Compose reads the app's own files, not a compose.yml in the daemon's folder.
    { timeoutMs: COMPOSE_TIMEOUT_MS, cwd: existsSync(join(dir, "src")) ? join(dir, "src") : paths.data },
  );
  // Containers that may still run could write while the files go, so a failed down keeps them for a retry.
  if (!command.removeData || !result.ok) return result;
  try {
    return { ...result, output: result.output + (await removeAsRoot(dir, command.project)) };
  } catch (error) {
    return { ok: false, exitCode: null, output: `${result.output}\n[kitshn: ${error instanceof Error ? error.message : String(error)}]` };
  }
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
      capabilities: ["update", "update-gz", "compose", "compose-redeploy"],
      version: VERSION,
      os: `${osPlatform()} ${release()}`,
      arch: arch(),
      hostname: hostname(),
      tunnel: tunnelState,
    },
  };
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

/** Keeps cloudflared running, with a growing pause after each exit. */
function superviseTunnel(binary: string, token: string) {
  let delay = 1000;
  let child: ChildProcess | null = null;
  process.on("exit", () => child?.kill());
  const start = () => {
    tunnelState = "starting";
    report();
    child = spawn(binary, ["tunnel", "--no-autoupdate", "run"], {
      env: { ...process.env, TUNNEL_TOKEN: token },
      stdio: ["ignore", "inherit", "inherit"],
    });
    const healthy = setTimeout(() => {
      tunnelState = "running";
      delay = 1000;
      report();
    }, 5000);
    child.on("exit", (code) => {
      clearTimeout(healthy);
      tunnelState = "stopped";
      report();
      log(`cloudflared exited with ${code}; starting it again in ${delay / 1000} s`);
      setTimeout(start, delay);
      delay = Math.min(delay * 2, 60_000);
    });
  };
  start();
}

const pendingResults: Array<DaemonMessage> = [];

function flushResults() {
  while (socket?.readyState === WebSocket.OPEN && pendingResults.length > 0) {
    socket.send(JSON.stringify(pendingResults.shift()));
  }
}

/** K-604: one WebSocket to kitshn, with backoff after a failure and a ping every 10 seconds. */
function connect(config: JoinSecrets) {
  joined = config;
  let delay = 1000;
  // After a 4001 or 4002 close, every later try waits an hour, until a connection opens again.
  let stopped = false;
  const open = () => {
    const url = new URL("/connect", config.server);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url.toString(), {
      headers: { "CF-Access-Client-Id": config.clientId, "CF-Access-Client-Secret": config.clientSecret },
    } as unknown as string);
    socket = ws;
    let lastPong = Date.now();
    let ping: ReturnType<typeof setInterval> | null = null;
    ws.onopen = () => {
      log("connected to kitshn");
      delay = 1000;
      stopped = false;
      flushResults();
      lastPong = Date.now();
      report();
      lastSites = "";
      void checkSites().catch((error: unknown) => log(`site check failed: ${String(error)}`));
      ws.send(JSON.stringify({ type: "sample", sample: sample() } satisfies DaemonMessage));
      ping = setInterval(() => {
        if (Date.now() - lastPong > PONG_TIMEOUT_MS) {
          log("no pong for 30 s; connecting again");
          ws.close();
          return;
        }
        ws.send("ping");
      }, PING_MS);
    };
    ws.onmessage = (event) => {
      const text = String(event.data);
      if (text === "pong") {
        lastPong = Date.now();
        return;
      }
      const message = JSON.parse(text) as ServerToDaemon;
      if (message.type === "job") {
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
          });
      }
    };
    ws.onclose = (event) => {
      if (ping) clearInterval(ping);
      socket = null;
      // 4001: another daemon with the same token took over; 4002: the owner removed this machine. Both
      // would swap forever with a short backoff, so they wait long (a removed machine also needs a new join).
      if (event.code === 4001 || event.code === 4002) stopped = true;
      const wait = stopped ? 60 * 60_000 : delay;
      log(`connection closed (${event.code} ${event.reason}); trying again in ${wait / 1000} s`);
      setTimeout(open, wait);
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
  pruneSamples();
  superviseTunnel(await ensureCloudflared(), config.tunnelToken);
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
    serviceCommand(args[0]);
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
kitshn expose <port|socket> --name <n>  share a local server at <n>.<zone> (K-1104); --dev sets Host localhost
kitshn unexpose <name>                  stop sharing it
kitshn version`);
}
