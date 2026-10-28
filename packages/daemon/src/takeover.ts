// K-1404: the takeover of KitSHn 1 data by root, for a daemon that uses rootless Docker. The daemon itself then
// cannot see the KitSHn 1 project on system Docker, and cannot read root-owned files in /persistent.
import { spawn } from "node:child_process";
import { chownSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kitshn1Deployment, movedVolume } from "./kitshn1.ts";
import { pathsFor } from "./service.ts";

/** busybox, pinned, as the daemon's own helper image. */
export const HELPER_IMAGE = "busybox:1.38@sha256:fd7dc98638c8e305f4dc34e979f1c0fdfdcaeb0fbf8fcff77ae834b6da3d7e6e";

const PROJECT = /^app-[a-z0-9-]{1,59}$/;

export interface RootTakeover {
  readonly oldProject: string;
  readonly oldData: string;
  readonly project: string;
  readonly appDir: string;
  readonly staged: string;
  readonly data: string;
  readonly marker: string;
}

/**
 * K-1404: the paths of one takeover, or why it cannot run. `project` is the Compose project of the kitshn 2 card
 * (its card id). The daemon user's data folder is the default one of Linux, as a user service has it.
 */
export function rootTakeoverPlan(input: {
  readonly repo: string;
  readonly environment: string;
  readonly project: string;
  readonly home: string;
  readonly uid: number;
  readonly persistentRoot: string;
  readonly exists: (path: string) => boolean;
}): RootTakeover | string {
  if (!PROJECT.test(input.project)) return `${input.project} is not the Compose project of a kitshn 2 card (app-...).`;
  const old = kitshn1Deployment(input.repo, input.environment, input.persistentRoot);
  if (!old) return `${input.repo} ${input.environment} is not a name that KitSHn 1 could use.`;
  if (!input.exists(old.dataDir)) return `there is no KitSHn 1 data at ${old.dataDir}.`;
  const appDir = join(pathsFor("linux", {}, input.home, input.uid).data, "apps", input.project);
  const plan: RootTakeover = {
    oldProject: old.project,
    oldData: old.dataDir,
    project: input.project,
    appDir,
    staged: join(appDir, "data.kitshn1"),
    data: join(appDir, "data"),
    marker: join(appDir, "kitshn1-taken"),
  };
  if (input.exists(plan.marker) || input.exists(plan.data))
    return `${input.project} has its data already (${plan.data}); kitshn takes KitSHn 1 data over only once.`;
  return plan;
}

/** K-1404: `docker info` of a rootless daemon names `rootless` among its security options. */
export const isRootlessInfo = (securityOptions: string) => securityOptions.includes("name=rootless");

type Program = readonly [string, ...Array<string>];

/** Runs a program, or a pipe of two (`from | to`), and fails with the end of their output. */
export function run(first: Program, second?: Program): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4000);
    };
    const [program, ...args] = first;
    const a = spawn(program, args, { stdio: ["ignore", second ? "pipe" : "inherit", "pipe"] });
    a.stderr?.on("data", keep);
    const children = [a];
    if (second) {
      const [to, ...toArgs] = second;
      // Bun takes no stream of another child as stdio, so the bytes go through this process.
      const b = spawn(to, toArgs, { stdio: ["pipe", "inherit", "pipe"] });
      if (!a.stdout || !b.stdin) throw new Error("the pipe has no stdout or stdin.");
      a.stdout.pipe(b.stdin);
      // A reader that stops early must not crash this process with EPIPE; its exit code reports the failure.
      b.stdin.on("error", () => undefined);
      b.stderr?.on("data", keep);
      children.push(b);
    }
    let left = children.length;
    let failed = false;
    for (const child of children)
      child.on("close", (code) => {
        if (code !== 0) failed = true;
        if (--left > 0) return;
        if (failed) reject(new Error(`${[first, second].filter(Boolean).map((p) => p!.join(" ")).join(" | ")} failed:\n${output}`));
        else resolve();
      });
  });
}

/**
 * K-1404: run by root. Stops the KitSHn 1 project on system Docker, then copies its data folder and its named
 * volumes into rootless Docker of the daemon user. `tar` unpacks inside a rootless container, so each owner maps as
 * the app sees it there. Only a complete copy becomes the data folder, with the marker that the daemon checks. On a
 * failure it removes the copies and starts KitSHn 1 again. The old folder and volumes stay for a rollback.
 */
export async function rootTakeover(plan: RootTakeover, user: { readonly name: string; readonly uid: number }) {
  const system: Program = ["docker", "-H", "unix:///var/run/docker.sock"];
  const rootless: Program = [
    "runuser", "-u", user.name, "--", "env", `XDG_RUNTIME_DIR=/run/user/${user.uid}`,
    "docker", "-H", `unix:///run/user/${user.uid}/docker.sock`,
  ];
  const made: Array<string> = [];
  console.log(`kitshn: stopping the KitSHn 1 project ${plan.oldProject}`);
  await run([...system, "compose", "-p", plan.oldProject, "stop"]);
  try {
    mkdirSync(plan.appDir, { recursive: true });
    chownSync(plan.appDir, user.uid, user.uid);
    rmSync(plan.staged, { recursive: true, force: true });
    mkdirSync(plan.staged);
    chownSync(plan.staged, user.uid, user.uid);
    console.log(`kitshn: copying ${plan.oldData}`);
    await run(
      ["tar", "-C", plan.oldData, "--numeric-owner", "-cf", "-", "."],
      [...rootless, "run", "--rm", "-i", "--network", "none", "-v", `${plan.staged}:/to`, HELPER_IMAGE, "tar", "-xpf", "-", "-C", "/to"],
    );
    const volumes = await listVolumes(system, plan.oldProject);
    for (const volume of volumes) {
      const target = movedVolume(volume, plan.oldProject, plan.project);
      if (!target) continue;
      console.log(`kitshn: copying the volume ${volume} to ${target}`);
      await run([
        ...rootless, "volume", "create",
        "--label", `com.docker.compose.project=${plan.project}`,
        "--label", `com.docker.compose.volume=${target.slice(plan.project.length + 1)}`,
        target,
      ]);
      made.push(target);
      await run(
        [...system, "run", "--rm", "--network", "none", "-v", `${volume}:/from:ro`, HELPER_IMAGE, "tar", "-cf", "-", "-C", "/from", "."],
        [...rootless, "run", "--rm", "-i", "--network", "none", "-v", `${target}:/to`, HELPER_IMAGE, "tar", "-xpf", "-", "-C", "/to"],
      );
    }
    renameSync(plan.staged, plan.data);
    writeFileSync(plan.marker, `${plan.oldData}\n`);
    chownSync(plan.marker, user.uid, user.uid);
  } catch (error) {
    rmSync(plan.staged, { recursive: true, force: true });
    for (const volume of made) await run([...rootless, "volume", "rm", volume]).catch(() => undefined);
    await run([...system, "compose", "-p", plan.oldProject, "start"]).catch(() => undefined);
    throw error;
  }
  console.log(
    `kitshn: KitSHn 1 data of ${plan.oldProject} is in ${plan.data}; it stays in ${plan.oldData} for a rollback. ` +
      "KitSHn 1 is stopped: deploy the kitshn 2 app now.",
  );
}

async function listVolumes(system: Program, project: string): Promise<Array<string>> {
  const [program, ...args] = system;
  return new Promise((resolve, reject) => {
    let out = "";
    const child = spawn(program, [...args, "volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]);
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("close", (code) =>
      code === 0 ? resolve(out.split("\n").map((line) => line.trim()).filter(Boolean)) : reject(new Error("docker volume ls failed")),
    );
  });
}
