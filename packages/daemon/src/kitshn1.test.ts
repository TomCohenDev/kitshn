import { describe, expect, it } from "vitest";
import { kitshn1Deployment, movedVolume, takeoverPlan } from "./kitshn1.ts";

describe("KitSHn 1 data of a moving app (K-1404)", () => {
  it("names the folder and the Compose project as KitSHn 1 did", () => {
    expect(kitshn1Deployment("Yarden-zamir/money", "prod", "/persistent")).toEqual({
      dataDir: "/persistent/Yarden-zamir/money/prod",
      project: "yarden-zamir-money-prod",
    });
    expect(kitshn1Deployment("Owner/My.App", "pr-7", "/p")?.project).toBe("owner-my-app-pr-7");
  });
  it("refuses names that would leave the persistent root", () => {
    for (const repo of ["../x", "a/..", "a/b/c", "a", "a/b c"])
      expect(kitshn1Deployment(repo, "prod", "/p")).toBeNull();
    expect(kitshn1Deployment("a/b", "..", "/p")).toBeNull();
  });
});

describe("the takeover decision (K-1404)", () => {
  const base = { repo: "o/app", environment: "prod", persistentRoot: "/p", hasData: false, taken: false };
  it("takes the KitSHn 1 data once, on the first deploy only", () => {
    expect(takeoverPlan({ ...base, exists: () => true })).toEqual({
      kind: "take",
      dataDir: "/p/o/app/prod",
      project: "o-app-prod",
    });
    expect(takeoverPlan({ ...base, hasData: true, exists: () => true }).kind).toBe("skip");
    expect(takeoverPlan({ ...base, taken: true, exists: () => true }).kind).toBe("skip");
  });
  it("starts a pull request preview fresh, also when its KitSHn 1 folder still exists", () => {
    expect(takeoverPlan({ ...base, environment: "pr-174", exists: () => true })).toEqual({
      kind: "skip",
      note: "A preview takes no KitSHn 1 data; /p/o/app/pr-174 stays for its deletion, and the app starts empty (K-1404).",
    });
    expect(takeoverPlan({ ...base, environment: "pr-174", exists: () => false })).toEqual({
      kind: "skip",
      note: null,
    });
    // Only a pull request environment: a name that starts with "pr" otherwise still takes its data.
    expect(takeoverPlan({ ...base, environment: "prod-eu", exists: () => true }).kind).toBe("take");
  });
  it("says so when there is no KitSHn 1 data to take", () => {
    expect(takeoverPlan({ ...base, exists: (path) => path === "/p/o/app" })).toEqual({
      kind: "skip",
      note: "No KitSHn 1 data at /p/o/app/prod; the app starts empty.",
    });
    // A machine or an app that KitSHn 1 never ran stays quiet.
    expect(takeoverPlan({ ...base, exists: () => false })).toEqual({ kind: "skip", note: null });
  });
  it("moves only the named volumes of the KitSHn 1 project", () => {
    expect(movedVolume("o-app-prod_sessions", "o-app-prod", "app-o-1-prod")).toBe("app-o-1-prod_sessions");
    expect(movedVolume("o-app-prod2_x", "o-app-prod", "app-o-1-prod")).toBeNull();
  });
});
