import { describe, expect, it } from "vitest";
import type { LastDeploy } from "./agent.ts";
import { appRestart, appTeardown, orphanVolumes } from "./apps.ts";
import type { AppCard } from "./changes.ts";
import { seed } from "./seed.ts";

const compose: AppCard = {
  id: "app-riffle-1-prod",
  kind: "site.compose",
  name: "riffle",
  addresses: ["riffle.example.com"],
  group: "riffle",
  machine: "vps",
};
const last: LastDeploy = {
  app: "compose",
  repo: "o/riffle",
  branch: "main",
  resourceId: compose.id,
  environment: "prod",
  name: "riffle",
  composeFile: null,
};
const ready = { canRedeploy: true, takesDeploys: true, runsCard: true, allowed: [] };

describe("app removal (K-909)", () => {
  it("takes down the Worker of a site, and stops a Compose app with its data kept", () => {
    expect(appTeardown({ ...compose, kind: "site.static", machine: null }, "kitshn-x", "example.com")).toEqual({
      kind: "worker",
      address: "riffle.example.com",
      script: "kitshn-x",
    });
    expect(appTeardown(compose, "", "example.com")).toEqual({
      kind: "compose",
      machineId: "vps",
      command: { kind: "compose-down", project: compose.id, name: "riffle", removeData: false },
    });
  });

  it("starts a Compose app from its last good build and builds a site again on its branch", () => {
    expect(appRestart(last, null, ready)).toMatchObject({
      kind: "redeploy",
      command: { kind: "compose-redeploy", project: compose.id, name: "riffle" },
    });
    expect(appRestart({ ...last, environment: "pr-3" }, null, ready)).toMatchObject({ kind: "redeploy" });
    expect(appRestart({ ...last, app: "static" }, null, null)).toEqual({ kind: "build", repo: "o/riffle", branch: "main" });
  });

  it("says why it starts nothing", () => {
    expect(appRestart({ ...last, app: "static", environment: "pr-3" }, null, null)).toEqual({
      kind: "none",
      reason: "The preview pr-3 comes back on the next push to its pull request.",
    });
    expect(appRestart(last, "kitshn is paused.", ready)).toEqual({ kind: "none", reason: "kitshn is paused." });
    expect(appRestart(last, null, { ...ready, takesDeploys: false })).toMatchObject({ kind: "none", reason: /label deploy/ });
    expect(appRestart(null, null, null)).toMatchObject({ kind: "none", reason: /next deploy/ });
  });

  it("lists as orphaned only the idle volumes whose app has no card", () => {
    const s = seed(["owner@example.com"], "kit.example.com");
    const state = {
      circles: new Map(),
      resources: new Map([...s.resources, { ...compose, status: "stopped" as const }].map((r) => [r.id, r])),
      places: new Map(),
      shareSettings: new Map(),
      stacks: new Map(),
      paused: null,
      machines: new Map(),
    };
    const kept = { name: `${compose.id}_data`, project: compose.id };
    const orphan = { name: "app-old-2-prod_data", project: "app-old-2-prod" };
    expect(orphanVolumes([kept, orphan], state)).toEqual([orphan]);
  });
});
