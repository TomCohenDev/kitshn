import { describe, expect, it } from "vitest";
import { isRootlessInfo, rootTakeoverPlan, run } from "./takeover.ts";

const base = {
  repo: "Yarden-zamir/tick3d",
  environment: "prod",
  project: "app-tick3d-123-prod",
  home: "/home/kitshn",
  uid: 1000,
  persistentRoot: "/persistent",
};

describe("KitSHn 1 takeover by root (K-1404)", () => {
  it("names the KitSHn 1 project and data, and the kitshn 2 data folder of the daemon user", () => {
    const plan = rootTakeoverPlan({ ...base, exists: (path) => path === "/persistent/Yarden-zamir/tick3d/prod" });
    expect(plan).toEqual({
      oldProject: "yarden-zamir-tick3d-prod",
      oldData: "/persistent/Yarden-zamir/tick3d/prod",
      project: "app-tick3d-123-prod",
      appDir: "/home/kitshn/.local/share/kitshn/apps/app-tick3d-123-prod",
      staged: "/home/kitshn/.local/share/kitshn/apps/app-tick3d-123-prod/data.kitshn1",
      data: "/home/kitshn/.local/share/kitshn/apps/app-tick3d-123-prod/data",
      marker: "/home/kitshn/.local/share/kitshn/apps/app-tick3d-123-prod/kitshn1-taken",
    });
  });

  it("refuses a second takeover, missing data, and names that leave their folders", () => {
    const all = () => true;
    expect(rootTakeoverPlan({ ...base, exists: all })).toMatch("only once");
    expect(rootTakeoverPlan({ ...base, exists: () => false })).toMatch("no KitSHn 1 data");
    expect(rootTakeoverPlan({ ...base, project: "../etc", exists: all })).toMatch("not the Compose project");
    expect(rootTakeoverPlan({ ...base, repo: "Yarden-zamir/../x", exists: all })).toMatch("could use");
  });

  it("knows a rootless Docker by its security options", () => {
    expect(isRootlessInfo('["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]')).toBe(true);
    expect(isRootlessInfo('["name=apparmor","name=seccomp,profile=builtin","name=cgroupns"]')).toBe(false);
  });

  it("fails a copy when either side of the pipe fails", async () => {
    await expect(run(["sh", "-c", "printf data"], ["sh", "-c", "cat >/dev/null"])).resolves.toBeUndefined();
    await expect(run(["sh", "-c", "printf data"], ["sh", "-c", "cat >/dev/null; echo broken >&2; exit 3"])).rejects.toThrow("broken");
    await expect(run(["sh", "-c", "exit 2"], ["sh", "-c", "cat >/dev/null"])).rejects.toThrow("failed");
  });
});
