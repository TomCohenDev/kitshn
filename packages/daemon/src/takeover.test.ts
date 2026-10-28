import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type DaemonUser,
  NO_TERMINAL,
  type Program,
  type Step,
  daemonUser,
  dockerKind,
  executeSteps,
  preflight,
  printable,
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

  it("never lets root touch the app folder, so a link there cannot make root follow it", async () => {
    // The checks before the steps run through a fake capture that records each program.
    const recorded: Array<Program> = [];
    const answers = (program: Program) => {
      const text = program.join(" ");
      if (text.startsWith("getent")) return "kitshn:x:1000:1000::/home/kitshn:/bin/sh\n";
      if (text.includes("show-environment")) return "PATH=/usr/bin\n";
      if (text.includes("volume ls")) return "yarden-zamir-tick3d-prod_sessions\n";
      if (text.includes("volume inspect -f")) return "/var/lib/docker/volumes/x/_data\n";
      if (text.includes("volume inspect")) throw new Error("no such volume");
      if (text.startsWith("du")) return "100\t/x\n100\ttotal\n";
      if (text.includes("DockerRootDir")) return "/home/kitshn/.local/share/docker\n";
      if (text.includes(" df ")) return "Mounted on Avail\n/ 1000000\n/ 1000000\n";
      return "";
    };
    const fake = (program: Program) => {
      recorded.push(program);
      return Promise.resolve().then(() => answers(program));
    };
    await daemonUser("kitshn", fake);
    const volumes = await preflight(plan, user, fake);
    const steps = takeoverSteps(plan, user, volumes);
    const all = steps.flatMap((step): Array<Step> => [step, ...(step.undo ?? [])]);
    const programs = [...recorded, ...all.flatMap((step) => [step.run, ...(step.pipeTo ? [step.pipeTo] : [])])];
    expect(programs.some((program) => program[0] === "du")).toBe(true);
    for (const program of programs) {
      const asUser = program[0] === "setsid" && program[2] === "runuser" && program[4] === "kitshn";
      if (asUser) {
        // A new session without a terminal, a clean environment, and no Docker CLI hooks of the user.
        expect(program[1]).toBe("--wait");
        expect(program).toContain("-i");
        expect(program).toContain("HOME=/home/kitshn");
        expect(program).toContain("DOCKER_CLI_HOOKS=0");
        continue;
      }
      expect(program.join(" ")).not.toContain("/home/kitshn");
      // Root reads /persistent and system Docker volumes, looks up the user, and talks to system Docker.
      const reads = program[0] === "tar" && program.includes("-cf") && program[2] === plan.oldData;
      const system = program[0] === "docker" && program[2] === "unix:///var/run/docker.sock";
      const sizes = program[0] === "du";
      const lookup = program[0] === "getent";
      expect(reads || system || sizes || lookup, program.join(" ")).toBe(true);
    }
    // The code of the takeover has no file system calls of its own.
    expect(readFileSync(new URL("./takeover.ts", import.meta.url), "utf8")).not.toContain('from "node:fs"');
  });

  it("gives no program of the takeover a terminal", async () => {
    expect(NO_TERMINAL).not.toContain("inherit");
    const children = new Set<never>();
    const noTerminal = "if [ -t 0 ] || [ -t 1 ] || [ -t 2 ]; then exit 9; fi";
    await expect(runStep({ name: "terminal", run: ["sh", "-c", noTerminal] }, children)).resolves.toBeUndefined();
    await expect(
      runStep({ name: "terminal", run: ["sh", "-c", "printf x"], pipeTo: ["sh", "-c", `cat >/dev/null; ${noTerminal}`] }, children),
    ).resolves.toBeUndefined();
  });

  it("waits for the programs of the current step before the undo starts", async () => {
    const order: Array<string> = [];
    let end: () => void = () => undefined;
    let abort: (error: Error) => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => (abort = reject));
    aborted.catch(() => undefined);
    const runner = {
      run: (step: Step) => {
        order.push(`run ${step.name}`);
        if (step.name.startsWith("copy")) return new Promise<void>((_, reject) => (end = () => (order.push("copy ended"), reject(new Error("killed")))));
        return Promise.resolve();
      },
      log: () => undefined,
    };
    const done = executeSteps(takeoverSteps(plan, user, []), runner, aborted);
    await new Promise((resolve) => setTimeout(resolve, 0));
    abort(new Error("stopped by SIGINT"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order.at(-1)).toBe(`run copy ${plan.oldData}`);
    end();
    await expect(done).rejects.toThrow("SIGINT");
    expect(order.indexOf("copy ended")).toBeLessThan(order.indexOf("run remove the copy"));
  });

  it("removes control characters from the output of programs", () => {
    expect(printable("ok\u001b[2J\u0007 line\n\tnext\u009b")).toBe("ok[2J line\n\tnext");
  });

  it("keeps a data folder that is not this run's, and refuses one that appeared before the rename", () => {
    const steps = takeoverSteps(plan, user, []);
    const finish = steps.find((step) => step.name === "make the copy the data folder")!;
    expect(finish.run.join(" ")).toContain("if [ -e /app/data ]; then");
    expect(finish.undo![0]!.run.join(" ")).toContain("if [ -e /app/data.kitshn1 ]; then rm -rf /app/data.kitshn1; else");
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
