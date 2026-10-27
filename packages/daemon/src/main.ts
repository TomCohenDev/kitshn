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
import {
  chmodSync,
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
async function updateDaemon(version: string): Promise<{ ok: boolean; exitCode: number | null; output: string }> {
  const failed = (output: string) => ({ ok: false, exitCode: null, output });
  if (!/^[0-9a-f]{12}$/.test(version)) return failed(`kitshn named no valid release (${version}).`);
  // A daemon run from source has the runtime as its execPath; replacing that would break the runtime.
  if (VERSION === "dev") return failed("This daemon runs from source; update it from the repo.");
  if (version === VERSION) return { ok: true, exitCode: 0, output: `Already at ${version}.` };
  const name = releaseAsset(platform, arch());
  const base = `${RELEASES}/edge-${version}`;
  try {
    const sums = await fetch(`${base}/SHA256SUMS`);
    const binary = await fetch(`${base}/${name}`);
    if (!sums.ok || !binary.ok) return failed(`The release edge-${version} has no ${name}.`);
    const expected = expectedHash(await sums.text(), name);
    const bytes = new Uint8Array(await binary.arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (!expected || expected !== actual) return failed(`${name} of edge-${version} does not match its SHA256SUMS.`);
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

function runJob(command: Command): Promise<{ ok: boolean; exitCode: number | null; output: string }> {
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
  return new Promise((resolve) => {
    let output = "";
    let done = false;
    const finish = (result: { ok: boolean; exitCode: number | null; output: string }) => {
      if (done) return;
      done = true;
      if (child.pid) runningGroups.delete(child.pid);
      clearTimeout(timer);
      resolve(result);
    };
    // Its own process group, so a timeout also ends the children that the script starts.
    const child = spawn("/bin/sh", ["-c", command.script], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    if (child.pid) runningGroups.add(child.pid);
    const add = (chunk: Buffer) => {
      if (output.length < OUTPUT_LIMIT)
        output += chunk.toString("utf8").slice(0, OUTPUT_LIMIT - output.length);
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
        output: `${output}\n[kitshn: the job ran longer than 10 minutes and was stopped]`,
      });
    }, JOB_TIMEOUT_MS);
    child.on("close", (code) => finish({ ok: code === 0, exitCode: code, output }));
    child.on("error", (error) => finish({ ok: false, exitCode: null, output: String(error) }));
  });
}

let tunnelState: "starting" | "running" | "stopped" = "stopped";
let socket: WebSocket | null = null;

function report() {
  const message: DaemonMessage = {
    type: "status",
    status: {
      capabilities: ["update"],
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
        void runJob(message.command).then((result) => {
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
  setInterval(() => void checkSites().catch((error: unknown) => log(`site check failed: ${String(error)}`)), 10_000);
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
