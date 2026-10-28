// K-1404: the takeover of KitSHn 1 data by root, for a daemon that uses rootless Docker. The daemon itself then
// cannot see the KitSHn 1 project on system Docker, and cannot read root-owned files in /persistent.
//
// The data folder of the daemon user is a path that this user controls, so a link there could point anywhere.
// Root therefore never touches it: root only reads /persistent and system Docker and streams bytes. Every step in
// that folder runs as the user, or in a rootless container of the user, so a link reaches only what the user can.
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { kitshn1Deployment, movedVolume } from "./kitshn1.ts";
import { isDigits, pathsFor } from "./service.ts";

/** busybox, pinned, as the daemon's own helper image. */
export const HELPER_IMAGE =
  "busybox:1.38@sha256:fd7dc98638c8e305f4dc34e979f1c0fdfdcaeb0fbf8fcff77ae834b6da3d7e6e";

const PROJECT = /^app-[a-z0-9-]{1,59}$/;

export interface DaemonUser {
  readonly name: string;
  readonly uid: number;
  readonly home: string;
  /** The environment of the user's service manager, for `XDG_DATA_HOME` as the daemon sees it. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface RootTakeover {
  readonly oldProject: string;
  readonly oldData: string;
  readonly project: string;
  /** The app folder of the kitshn 2 card. Only the user and its rootless containers touch it. */
  readonly appDir: string;
}

/** K-1404: the names of one takeover, or why it cannot run. `project` is the Compose project (card id) of kitshn 2. */
export function rootTakeoverPlan(input: {
  readonly repo: string;
  readonly environment: string;
  readonly project: string;
  readonly user: DaemonUser;
  readonly persistentRoot: string;
  readonly exists: (path: string) => boolean;
}): RootTakeover | string {
  if (!PROJECT.test(input.project))
    return `${input.project} is not the Compose project of a kitshn 2 card (app-...).`;
  const old = kitshn1Deployment(input.repo, input.environment, input.persistentRoot);
  if (!old) return `${input.repo} ${input.environment} is not a name that KitSHn 1 could use.`;
  // /persistent belongs to root, so root may look there; the user's folder is checked by the user (`prepare`).
  if (!input.exists(old.dataDir)) return `there is no KitSHn 1 data at ${old.dataDir}.`;
  // The user sets XDG_DATA_HOME, and root prints the paths below it, so it must be a plain absolute path.
  const xdg = input.user.env["XDG_DATA_HOME"];
  if (xdg !== undefined && xdg !== "" && (!xdg.startsWith("/") || hasControl(xdg)))
    return "XDG_DATA_HOME of the daemon user is not an absolute path without control characters.";
  const data = pathsFor("linux", input.user.env, input.user.home, input.user.uid).data;
  return {
    oldProject: old.project,
    oldData: old.dataDir,
    project: input.project,
    appDir: join(data, "apps", input.project),
  };
}

/**
 * K-1404: what `docker info` says about the daemon's Docker. A failed `docker info` is "unknown", and a deploy that
 * would take KitSHn 1 data over then stops, so it never copies on a Docker that it cannot name.
 */
export function dockerKind(info: {
  readonly ok: boolean;
  readonly output: string;
}): "rootless" | "system" | "unknown" {
  if (!info.ok) return "unknown";
  return info.output.includes("name=rootless") ? "rootless" : "system";
}

export type Program = readonly [string, ...Array<string>];

/** One step of the takeover: a program, or a pipe of two. `cwd` is "/" for root, so no Compose file there counts. */
export interface Step {
  readonly name: string;
  readonly run: Program;
  readonly pipeTo?: Program;
  /** Registered before the step runs, so a step that fails part-way is undone too. */
  readonly undo?: ReadonlyArray<Step>;
}

/** The programs of root and of the user. The user's environment is empty but for what Docker needs. */
export function programs(user: DaemonUser) {
  const system: Program = ["docker", "-H", "unix:///var/run/docker.sock"];
  // A new session without a controlling terminal, so no program of the user can type into root's terminal
  // (TIOCSTI); the user's Docker CLI hooks stay off.
  const asUser = (...command: [string, ...Array<string>]): Program => [
    // Absolute paths: the PATH of root can lack /usr/sbin, for example in a remote shell.
    "/usr/bin/setsid",
    "--wait",
    "/usr/sbin/runuser",
    "-u",
    user.name,
    "--",
    "env",
    "-i",
    `HOME=${user.home}`,
    "PATH=/usr/local/bin:/usr/bin:/bin",
    `XDG_RUNTIME_DIR=/run/user/${user.uid}`,
    "DOCKER_CLI_HOOKS=0",
    ...command,
  ];
  const rootless = (...args: Array<string>): Program =>
    asUser("docker", "-H", `unix:///run/user/${user.uid}/docker.sock`, ...args);
  /** A rootless container with the app folder at /app; it runs `script` with `sh -c`. */
  const inApp = (appDir: string, script: string, env: Record<string, string> = {}): Program =>
    rootless(
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "-v",
      `${appDir}:/app`,
      ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      HELPER_IMAGE,
      "sh",
      "-c",
      script,
    );
  return { system, asUser, rootless, inApp };
}

export const startCommand = (oldProject: string) =>
  `docker -H unix:///var/run/docker.sock compose -p ${oldProject} start`;

/**
 * K-1404: the steps of one takeover, in order. Root runs only `tar -c` on /persistent and system Docker; the
 * app folder sees only the user and its rootless containers.
 */
export function takeoverSteps(
  plan: RootTakeover,
  user: DaemonUser,
  volumes: ReadonlyArray<string>,
): Array<Step> {
  const { system, asUser, rootless, inApp } = programs(user);
  // While the staged copy exists, `data` is not this run's; after the rename, `data` and the marker are.
  const removeAll: Step = {
    name: "remove the copy",
    run: inApp(
      plan.appDir,
      "if [ -e /app/data.kitshn1 ]; then rm -rf /app/data.kitshn1; else rm -rf /app/data /app/kitshn1-taken; fi",
    ),
  };
  const steps: Array<Step> = [
    { name: "make the app folder", run: asUser("mkdir", "-p", "--", plan.appDir) },
    {
      name: "check the app folder",
      // A data folder or a marker means a takeover or a deploy came first; kitshn copies KitSHn 1 data only once.
      run: inApp(
        plan.appDir,
        'if [ -e /app/data ] || [ -e /app/kitshn1-taken ]; then echo "the app has its data already; kitshn takes KitSHn 1 data over only once" >&2; exit 3; fi; rm -rf /app/data.kitshn1 && mkdir /app/data.kitshn1',
      ),
    },
    {
      name: `stop the KitSHn 1 project ${plan.oldProject}`,
      run: [...system, "compose", "-p", plan.oldProject, "stop"],
      undo: [
        {
          name: `start the KitSHn 1 project ${plan.oldProject}`,
          run: [...system, "compose", "-p", plan.oldProject, "start"],
        },
      ],
    },
    {
      name: `copy ${plan.oldData}`,
      run: ["tar", "-C", plan.oldData, "--numeric-owner", "-cf", "-", "."],
      pipeTo: inApp(plan.appDir, "tar -xpf - -C /app/data.kitshn1"),
      undo: [removeAll],
    },
  ];
  for (const volume of volumes) {
    const target = movedVolume(volume, plan.oldProject, plan.project);
    if (!target) continue;
    steps.push(
      {
        name: `create the volume ${target}`,
        run: rootless(
          "volume",
          "create",
          "--label",
          `com.docker.compose.project=${plan.project}`,
          "--label",
          `com.docker.compose.volume=${target.slice(plan.project.length + 1)}`,
          target,
        ),
        undo: [{ name: `remove the volume ${target}`, run: rootless("volume", "rm", target) }],
      },
      {
        name: `copy the volume ${volume}`,
        run: [
          ...system,
          "run",
          "--rm",
          "--network",
          "none",
          "-v",
          `${volume}:/from:ro`,
          HELPER_IMAGE,
          "tar",
          "-cf",
          "-",
          "-C",
          "/from",
          ".",
        ],
        pipeTo: rootless(
          "run",
          "--rm",
          "-i",
          "--network",
          "none",
          "-v",
          `${target}:/to`,
          HELPER_IMAGE,
          "tar",
          "-xpf",
          "-",
          "-C",
          "/to",
        ),
      },
    );
  }
  steps.push({
    name: "make the copy the data folder",
    // Only a complete copy becomes `data`, with the marker that the daemon checks. A marker that fails after the
    // rename takes `data` with it, so a later deploy never runs on a copy without its marker.
    run: inApp(
      plan.appDir,
      'if [ -e /app/data ]; then echo "a data folder appeared after the check" >&2; exit 4; fi; mv /app/data.kitshn1 /app/data && printf "%s\\n" "$FROM" > /app/kitshn1-taken',
      { FROM: plan.oldData },
    ),
    undo: [removeAll],
  });
  return steps;
}

/** The volume names of the KitSHn 1 project that this takeover makes, so they can be checked first. */
export const targetVolumes = (plan: RootTakeover, volumes: ReadonlyArray<string>) =>
  volumes.flatMap((volume) => movedVolume(volume, plan.oldProject, plan.project) ?? []);

export interface Runner {
  /** Runs one step and fails with the end of its output. */
  readonly run: (step: Step) => Promise<void>;
  readonly log: (text: string) => void;
}

/**
 * K-1404: runs the steps in order. On a failure, a signal or the timeout, it undoes the started steps in reverse
 * and prints each undo that fails, so root knows what stays down.
 */
export async function executeSteps(
  steps: ReadonlyArray<Step>,
  runner: Runner,
  aborted: Promise<never>,
): Promise<void> {
  const undo: Array<Step> = [];
  let current: Promise<void> | null = null;
  try {
    for (const step of steps) {
      undo.push(...(step.undo ?? []));
      runner.log(`kitshn: ${step.name}`);
      current = runner.run(step);
      await Promise.race([current, aborted]);
      current = null;
    }
  } catch (error) {
    // On a signal or the timeout, the programs of the current step end first, so no undo races them.
    // Known limit: an undo step has no time limit, so a Docker that hangs after the 2-hour timeout holds it. The way
    // out: a second Ctrl-C kills the programs of that undo step, and the undo goes on with the next one.
    if (current) await current.catch(() => undefined);
    runner.log(`kitshn: failed: ${error instanceof Error ? error.message : String(error)}`);
    for (const step of [...undo].reverse()) {
      runner.log(`kitshn: undo: ${step.name}`);
      await runner
        .run(step)
        .catch((undoError: unknown) =>
          runner.log(
            `kitshn: undo failed: ${step.name}: ${undoError instanceof Error ? undoError.message : String(undoError)}`,
          ),
        );
    }
    throw error;
  }
}

const isControl = (char: string) => {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
};

/** Whether a text has a control character, also a newline or a tab. */
export const hasControl = (text: string) => [...text].some(isControl);

/** Text of a program without control characters, so output of the user cannot drive root's terminal. */
export function printable(text: string): string {
  return [...text].filter((char) => char === "\n" || char === "\t" || !isControl(char)).join("");
}

/**
 * The standard streams of every program of the takeover: never a terminal of root. Output goes to a pipe and shows
 * only when the step fails.
 */
export const NO_TERMINAL = ["ignore", "pipe", "pipe"] as const;

/** Runs a program, or a pipe of two, from "/". `children` lets a signal stop them. */
export function runStep(step: Step, children: Set<ChildProcess>): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + printable(chunk.toString("utf8"))).slice(-4000);
    };
    const start = ([program, ...args]: Program, stdin: "ignore" | "pipe", readOut: boolean) => {
      const child = spawn(program, args, { cwd: "/", stdio: [stdin, NO_TERMINAL[1], NO_TERMINAL[2]] });
      children.add(child);
      child.stderr?.on("data", keep);
      if (readOut) child.stdout?.on("data", keep);
      return child;
    };
    const a = start(step.run, NO_TERMINAL[0], !step.pipeTo);
    const all = [a];
    if (step.pipeTo) {
      // Bun takes no stream of another child as stdio, so the bytes go through this process.
      const b = start(step.pipeTo, "pipe", true);
      a.stdout!.pipe(b.stdin!);
      // A reader that stops early must not crash this process with EPIPE; its exit code reports the failure.
      b.stdin!.on("error", () => undefined);
      all.push(b);
    }
    let left = all.length;
    let failed = false;
    for (const child of all) {
      // A child that cannot start may report both "error" and "close"; it counts once.
      let ended = false;
      const end = (ok: boolean) => {
        if (ended) return;
        ended = true;
        children.delete(child);
        if (!ok) failed = true;
        if (--left > 0) return;
        if (failed) reject(new Error(`${step.name} failed:\n${output}`));
        else resolve();
      };
      child.on("error", (error) => {
        keep(Buffer.from(String(error)));
        end(false);
      });
      child.on("close", (code) => end(code === 0));
    }
  });
}

/** Runs a program from "/" and returns its standard output, or fails. */
export function capture(program: Program): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const [name, ...args] = program;
    const child = spawn(name, args, { cwd: "/", stdio: [...NO_TERMINAL] });
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`${program.join(" ")} failed: ${printable(err.slice(-2000))}`)),
    );
  });
}

/** The overall limit of one takeover; a hung Docker must not keep KitSHn 1 stopped without a word. */
const TAKEOVER_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * K-1404: run by root. It checks the free space and the target volumes first, then stops KitSHn 1, copies its data
 * folder and named volumes into rootless Docker of the user, and writes the marker. Any failure, Ctrl-C, SIGTERM or
 * the timeout undoes the started steps. Known limit: the copy keeps owners and modes, not ACLs or extended
 * attributes, and device nodes fail in the user namespace.
 */
export type Capture = (program: Program) => Promise<string>;

const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";
const bytesOf = (text: string) => {
  const value = Number(lastLine(text).split("\t")[0]);
  if (!Number.isFinite(value))
    throw new Error(`kitshn cannot read a size from: ${printable(text.slice(0, 200))}`);
  return value;
};

/** K-1404: what the checks found: the volumes of the KitSHn 1 project, and the sockets that the copy leaves out. */
export interface Preflight {
  readonly volumes: Array<string>;
  readonly skipped: Array<string>;
}

/**
 * K-1404: the checks before anything stops. It fails when a target volume exists already, a disk lacks room, or the
 * data holds a device node or a FIFO. Root reads only system Docker and its own folders; the folders of the user are
 * measured by the user.
 */
export async function preflight(plan: RootTakeover, user: DaemonUser, run: Capture): Promise<Preflight> {
  const { system, asUser, rootless } = programs(user);
  const volumes = (
    await run([
      ...system,
      "volume",
      "ls",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${plan.oldProject}`,
    ])
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const target of targetVolumes(plan, volumes)) {
    const exists = await run(rootless("volume", "inspect", target)).then(
      () => true,
      () => false,
    );
    if (exists)
      throw new Error(`the volume ${target} exists already in rootless Docker; remove it or check it first.`);
  }
  // The apparent size, so a sparse file counts in full: busybox tar in the helper cannot write sparse files.
  // -D and -H: a linked data folder counts and is scanned as `tar -C` copies it, through the link.
  const dataNeed = bytesOf(await run(["du", "-D", "--apparent-size", "-sb", "--", plan.oldData]));
  const mounts = await Promise.all(
    volumes.map(async (volume) =>
      (await run([...system, "volume", "inspect", "-f", "{{.Mountpoint}}", volume])).trim(),
    ),
  );
  const volumeNeed =
    mounts.length === 0 ? 0 : bytesOf(await run(["du", "--apparent-size", "-sbc", "--", ...mounts]));
  // tar in a user namespace drops device nodes and FIFOs with a warning and exits 0, so the copy would lose them in
  // silence; kitshn refuses such data before anything stops. A socket holds no data and a running app makes it again,
  // so the copy leaves sockets out and the command names them.
  const special = (
    await run([
      "find",
      "-H",
      plan.oldData,
      ...mounts,
      "(",
      "-type",
      "b",
      "-o",
      "-type",
      "c",
      "-o",
      "-type",
      "p",
      ")",
      "-print",
      "-quit",
    ])
  ).trim();
  if (special)
    throw new Error(
      `the data holds a device node or a FIFO, which the copy would drop: ${special}. Remove or move it, then run this command again.`,
    );
  const skipped = (await run(["find", "-H", plan.oldData, ...mounts, "-type", "s", "-print"]))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  await run(asUser("mkdir", "-p", "--", plan.appDir));
  const dockerRoot = (await run(rootless("info", "--format", "{{.DockerRootDir}}"))).trim();
  // One line for each folder: its mount point and its free bytes, so two folders on one disk add up.
  const disks = (await run(asUser("df", "-B1", "--output=target,avail", "--", plan.appDir, dockerRoot)))
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ").filter(Boolean));
  const [app, docker] = disks;
  if (!app || !docker || app.length !== 2 || docker.length !== 2)
    throw new Error("kitshn cannot read the free space.");
  const need = new Map<string, number>();
  need.set(app[0]!, (need.get(app[0]!) ?? 0) + dataNeed);
  need.set(docker[0]!, (need.get(docker[0]!) ?? 0) + volumeNeed);
  const free = new Map([
    [app[0]!, Number(app[1])],
    [docker[0]!, Number(docker[1])],
  ]);
  for (const [disk, bytes] of need) {
    const left = free.get(disk) ?? Number.NaN;
    // Room for the copy and a tenth more, so the disk never fills up.
    if (!Number.isFinite(left) || bytes * 1.1 > left)
      throw new Error(`the copy needs ${bytes} bytes on ${disk}, which has ${left} bytes free.`);
  }
  return { volumes, skipped };
}

export async function rootTakeover(plan: RootTakeover, user: DaemonUser): Promise<void> {
  const { volumes, skipped } = await preflight(plan, user, capture);
  // Every line that root prints goes through printable(): paths and output can hold text of the user.
  const say = (text: string) => console.log(printable(text));
  for (const path of skipped) say(`kitshn: skipped: ${path}`);
  // Printed before anything stops, so it is on the screen even after a hard kill.
  say(
    `kitshn: if KitSHn 1 stays down after this command, start it with:\n  ${startCommand(plan.oldProject)}`,
  );
  const children = new Set<ChildProcess>();
  let abort: (reason: Error) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = reject;
  });
  aborted.catch(() => undefined);
  const stopAll = (reason: string) => {
    for (const child of children) {
      child.kill("SIGTERM");
      // A program that ignores SIGTERM ends with SIGKILL, so the undo still runs.
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }
    abort(new Error(reason));
  };
  const onSignal = (signal: NodeJS.Signals) => stopAll(`stopped by ${signal}`);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const timer = setTimeout(() => stopAll("the takeover took longer than 2 hours"), TAKEOVER_TIMEOUT_MS);
  try {
    await executeSteps(
      takeoverSteps(plan, user, volumes),
      { run: (step) => runStep(step, children), log: say },
      aborted,
    );
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  say(
    `kitshn: KitSHn 1 data of ${plan.oldProject} is in ${plan.appDir}/data; it stays in ${plan.oldData} for a rollback.\n` +
      "kitshn: KitSHn 1 stays stopped, so the site is down until the kitshn 2 app deploys. To start KitSHn 1 again:\n" +
      `  ${startCommand(plan.oldProject)}`,
  );
}

/** K-1404: the daemon user as root sees it, with the environment of its service manager. */
export async function daemonUser(name: string, run: Capture = capture): Promise<DaemonUser> {
  const entry = (await run(["getent", "passwd", name])).trim();
  const [, , uid = "", , , home = ""] = entry.split(":");
  if (!isDigits(uid) || !home) throw new Error(`there is no user ${name}.`);
  const user: DaemonUser = { name, uid: Number(uid), home, env: {} };
  const shown = await run(programs(user).asUser("systemctl", "--user", "show-environment"));
  const env: Record<string, string> = {};
  for (const line of shown.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  return { ...user, env };
}
