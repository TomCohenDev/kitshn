import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type DaemonUser,
  type Step,
  dockerKind,
  executeSteps,
  rootTakeoverPlan,
  runStep,
  takeoverSteps,
} from "./takeover.ts";

const user: DaemonUser = { name: "kitshn", uid: 1000, home: "/home/kitshn", env: {} };
const base = {
  repo: "Yarden-zamir/tick3d",
  environment: "prod",
  project: "app-tick3d-123-prod",
  user,
  persistentRoot: "/persistent",
};
const plan = {
  oldProject: "yarden-zamir-tick3d-prod",
  oldData: "/persistent/Yarden-zamir/tick3d/prod",
  project: "app-tick3d-123-prod",
  appDir: "/home/kitshn/.local/share/kitshn/apps/app-tick3d-123-prod",
};
const never = new Promise<never>(() => undefined);

describe("KitSHn 1 takeover by root (K-1404)", () => {
  it("names the KitSHn 1 project and data, and the app folder of the daemon user, with its XDG_DATA_HOME", () => {
    expect(rootTakeoverPlan({ ...base, exists: (path) => path === plan.oldData })).toEqual(plan);
    const moved = rootTakeoverPlan({ ...base, user: { ...user, env: { XDG_DATA_HOME: "/srv/kitshn" } }, exists: () => true });
    expect(moved).toMatchObject({ appDir: "/srv/kitshn/kitshn/apps/app-tick3d-123-prod" });
  });

  it("refuses missing data and names that leave their folders", () => {
    expect(rootTakeoverPlan({ ...base, exists: () => false })).toMatch("no KitSHn 1 data");
    expect(rootTakeoverPlan({ ...base, project: "../etc", exists: () => true })).toMatch("not the Compose project");
    expect(rootTakeoverPlan({ ...base, repo: "Yarden-zamir/../x", exists: () => true })).toMatch("could use");
  });

  it("never lets root touch the app folder, so a link there cannot make root follow it", () => {
    const steps = takeoverSteps(plan, user, ["yarden-zamir-tick3d-prod_sessions"]);
    const all = steps.flatMap((step): Array<Step> => [step, ...(step.undo ?? [])]);
    const programs = all.flatMap((step) => [step.run, ...(step.pipeTo ? [step.pipeTo] : [])]);
    for (const program of programs) {
      const asUser = program[0] === "runuser" && program[1] === "-u" && program[2] === "kitshn";
      if (asUser) {
        // A clean environment: no HOME or DOCKER_* of root.
        expect(program).toContain("-i");
        expect(program).toContain("HOME=/home/kitshn");
        continue;
      }
      expect(program.join(" ")).not.toContain("/home/kitshn");
      // Root reads /persistent with tar, or talks to system Docker; nothing else.
      const reads = program[0] === "tar" && program.includes("-cf") && program[2] === plan.oldData;
      const system = program[0] === "docker" && program[2] === "unix:///var/run/docker.sock";
      expect(reads || system, program.join(" ")).toBe(true);
    }
    // The code of the takeover has no file system calls of its own.
    expect(readFileSync(new URL("./takeover.ts", import.meta.url), "utf8")).not.toContain('from "node:fs"');
  });

  it("stops a deploy when docker info fails, instead of copying on a Docker it cannot name", () => {
    expect(dockerKind({ ok: false, output: "" })).toBe("unknown");
    expect(dockerKind({ ok: true, output: '["name=seccomp,profile=builtin","name=rootless"]' })).toBe("rootless");
    expect(dockerKind({ ok: true, output: '["name=apparmor","name=seccomp,profile=builtin"]' })).toBe("system");
  });

  it("removes the renamed data and starts KitSHn 1 again when the marker fails, and prints each undo", async () => {
    const ran: Array<string> = [];
    const log: Array<string> = [];
    const steps = takeoverSteps(plan, user, []);
    const runner = {
      run: (step: Step) => {
        ran.push(step.name);
        if (step.name === "make the copy the data folder") return Promise.reject(new Error("no space for the marker"));
        if (step.name.startsWith("start the KitSHn 1")) return Promise.reject(new Error("docker is down"));
        return Promise.resolve();
      },
      log: (text: string) => log.push(text),
    };
    await expect(executeSteps(steps, runner, never)).rejects.toThrow("no space for the marker");
    const undone = ran.slice(ran.indexOf("make the copy the data folder") + 1);
    expect(undone).toEqual(["remove the copy", "remove the copy", "start the KitSHn 1 project yarden-zamir-tick3d-prod"]);
    const remove = steps.find((step) => step.name === "make the copy the data folder")!.undo![0]!;
    expect(remove.run.join(" ")).toContain("/app/data ");
    expect(log.some((line) => line.includes("undo failed: start the KitSHn 1 project"))).toBe(true);
  });

  it("fails a pipe when either side fails", async () => {
    const children = new Set<never>();
    const step = (run: Step["run"], pipeTo: Step["pipeTo"]): Step => ({ name: "pipe", run, ...(pipeTo ? { pipeTo } : {}) });
    await expect(runStep(step(["sh", "-c", "printf data"], ["sh", "-c", "cat >/dev/null"]), children)).resolves.toBeUndefined();
    await expect(runStep(step(["sh", "-c", "printf data"], ["sh", "-c", "cat >/dev/null; echo broken >&2; exit 3"]), children)).rejects.toThrow("broken");
    await expect(runStep(step(["sh", "-c", "exit 2"], ["sh", "-c", "cat >/dev/null"]), children)).rejects.toThrow("failed");
    await expect(runStep(step(["kitshn-no-such-program"], undefined), children)).rejects.toThrow("failed");
  });
});
