import { describe, expect, it } from "vitest";
import {
  environmentNames,
  jobError,
  keptImages,
  eventOf,
  legacyRepos,
  parseConfigFile,
  parseManifest,
  parseSiteIcon,
  parseWorkerSecrets,
  pullRequestNumber,
  repoIdOf,
  workerMetadata,
} from "./deploys.ts";

describe("deploys (K-811, K-903)", () => {
  it("takes the event, branch and pull request from the token, not from the request", () => {
    const push = { eventName: "push", branch: "feature-x", pr: null };
    expect(eventOf(push, { name: "push", branch: "main", action: "closed" })).toEqual({
      name: "push",
      branch: "feature-x",
      pr: null,
      action: null,
    });
    // K-718: a dispatch through the App deploys the dispatched branch's code, as a push of that branch.
    expect(eventOf({ eventName: "workflow_dispatch", branch: "main", pr: null }, {})).toEqual({
      name: "push",
      branch: "main",
      pr: null,
      action: null,
    });
    expect(eventOf({ eventName: "schedule", branch: "main", pr: null }, {})).toMatch(/not on schedule/);
    const pull = { eventName: "pull_request", branch: "x", pr: 7 };
    expect(eventOf(pull, { action: "closed", pr: 1 })).toEqual({
      name: "pull_request",
      branch: "x",
      pr: 7,
      action: "closed",
    });
    // A closed pull request's token has no number; the request's number is only a claim to check.
    expect(
      eventOf({ eventName: "pull_request", branch: "x", pr: null }, { action: "closed", pr: 7 }),
    ).toEqual({
      name: "pull_request",
      branch: "x",
      pr: 7,
      action: "closed",
      claimed: true,
    });
    expect(
      eventOf({ eventName: "pull_request", branch: "x", pr: null }, { action: "opened", pr: 7 }),
    ).toMatchObject({
      pr: null,
    });
  });

  it("reads the pull request of a pr-<n> environment only (K-303)", () => {
    expect(
      ["pr-41", "pr-1234", "prod", "pr-", "pr-4a", "pr-0", "pr-07", "staging-pr-3"].map(pullRequestNumber),
    ).toEqual([41, 1234, null, null, null, null, null, null]);
  });

  it("keeps repos with similar names apart", () => {
    expect(environmentNames("1", "me/my.site", "prod").script).not.toBe(
      environmentNames("2", "me/my-site", "prod").script,
    );
    expect(environmentNames("1", "me/hello", "prod").script.length).toBeLessThanOrEqual(63);
    const long = (env: string) =>
      environmentNames("1061234567", "me/a-fairly-long-repository-name", env).resourceId;
    expect(long("preview-branch-101")).not.toBe(long("preview-branch-102"));
    expect(long("preview-branch-101").length).toBeLessThanOrEqual(56);
  });

  it("checks the asset manifest", () => {
    expect(parseManifest({ "/index.html": { hash: "a".repeat(32), size: 10 } })).toEqual({
      "/index.html": { hash: "a".repeat(32), size: 10 },
    });
    expect(parseManifest({ "index.html": { hash: "a".repeat(32), size: 10 } })).toMatch(/path/);
    expect(parseManifest({})).toMatch(/files/);
  });

  it("finds the repo id inside a card id, only with the repo name that made it (K-819)", () => {
    const card = environmentNames("42", "me/my-site", "prod").resourceId;
    expect(repoIdOf("me/my-site", "prod", card)).toBe("42");
    // After a rename the old name of the deploy row still finds it; the new name does not.
    expect(repoIdOf("me/renamed", "prod", card)).toBeNull();
    // Another repo that reuses the name has its own id in its own card.
    expect(repoIdOf("me/my-site", "prod", environmentNames("43", "me/my-site", "prod").resourceId)).toBe(
      "43",
    );
    const long = "feature/a-very-long-branch-name-that-needs-a-hash";
    const hashed = environmentNames("1061234567", "me/a-fairly-long-repository-name", long).resourceId;
    expect(repoIdOf("me/a-fairly-long-repository-name", long, hashed)).toBe("1061234567");
    // A card id from before the repo id was part of it.
    expect(repoIdOf("me/my-site", "prod", "app-me-my-site-prod")).toBeNull();
  });

  it("allows only the repos that finished a deploy before the gate (K-819)", () => {
    const row = (id: string, repoId: string, repo: string, kind: string, state: string) => ({
      id,
      repo,
      environment: "pr-1",
      resourceId: environmentNames(repoId, repo, "pr-1").resourceId,
      kind,
      state,
    });
    const { repoIds, allowed, unknown } = legacyRepos([
      row("d1", "1", "me/old-name", "deploy", "done"),
      row("d2", "1", "me/new-name", "deploy", "failed"),
      row("d3", "2", "me/teardown-only", "teardown", "done"),
      row("d4", "3", "me/never-done", "deploy", "running"),
      { ...row("d5", "4", "me/x", "deploy", "done"), resourceId: "app-me-x-pr-1" },
    ]);
    expect(Object.fromEntries(repoIds)).toEqual({ d1: "1", d2: "1", d3: "2", d4: "3" });
    expect(Object.fromEntries(allowed)).toEqual({ "1": "me/old-name" });
    expect(unknown).toEqual(["d5"]);
  });
});

describe("site icon of a deploy (K-1113)", () => {
  const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0));

  it("takes an image by its bytes, and keeps the stored icon for a CLI without icons", () => {
    expect(parseSiteIcon(PNG)).toMatchObject({ type: "image/png" });
    expect(parseSiteIcon(null)).toBeNull();
    expect(parseSiteIcon(undefined)).toBeUndefined();
  });

  it("refuses what is no image, too large, or no base64", () => {
    expect(parseSiteIcon(btoa("<html>hi</html>"))).toMatch(/not a PNG/);
    expect(parseSiteIcon("A".repeat(200_000))).toMatch(/larger than 100 KB/);
    expect(parseSiteIcon("%%%")).toMatch(/base64/);
    expect(parseSiteIcon(42)).toMatch(/base64 text or null/);
  });

  it("passes a _headers file on as text, and refuses one that is not text or too large (K-805)", () => {
    expect(parseConfigFile("_headers", "/*.gpx\n  Content-Type: application/gpx+xml\n")).toMatch("gpx");
    expect(parseConfigFile("_headers", undefined)).toBeNull();
    expect(parseConfigFile("_headers", null)).toBeNull();
    expect(parseConfigFile("_redirects", 42)).toEqual({ error: expect.stringContaining("text") });
    expect(parseConfigFile("_headers", "x".repeat(100_001))).toEqual({
      error: expect.stringContaining("larger"),
    });
    // Bytes, not characters: 40,000 three-byte characters are 120 KB.
    expect(parseConfigFile("_redirects", "€".repeat(40_000))).toEqual({
      error: expect.stringContaining("larger"),
    });
  });
});

describe("Worker apps (K-806)", () => {
  const access = { teamDomain: "team.cloudflareaccess.com", audiences: [] };

  it("declares the Durable Object classes as exports, from the recipe only, so a retry sends the same", () => {
    const result = workerMetadata(
      {
        main: "worker.js",
        compatibilityDate: "2026-10-01",
        durableObjects: { ROOMS: "Room", LOBBY: "Room" },
      },
      { kv: new Map(), secrets: {}, access, assets: null },
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.metadata["exports"]).toEqual({ Room: { type: "durable-object", storage: "sqlite" } });
    expect(result.metadata).not.toHaveProperty("migrations");
  });

  it("sets the KV ids of the environment, passes the values of the run as secrets and the Access values as vars (K-822)", () => {
    const result = workerMetadata(
      {
        main: "worker.js",
        compatibilityDate: "2026-10-01",
        kv: ["STATS"],
        durableObjects: { ROOMS: "Room" },
        // The app's own value wins over kitshn's.
        vars: { MODE: "live", KITSHN_ACCESS_TEAM_DOMAIN: "own.example.com" },
        assets: { folder: "site", runWorkerFirst: ["/api/*"] },
      },
      {
        kv: new Map([["STATS", "ns-1"]]),
        secrets: { GITHUB_TOKEN: "t" },
        access: { teamDomain: "team.cloudflareaccess.com", audiences: ["aud-1", "aud-2"] },
        assets: { jwt: "j", headers: null, redirects: null },
      },
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.metadata["bindings"]).toEqual([
      { type: "assets", name: "ASSETS" },
      { type: "kv_namespace", name: "STATS", namespace_id: "ns-1" },
      { type: "durable_object_namespace", name: "ROOMS", class_name: "Room" },
      { type: "plain_text", name: "MODE", text: "live" },
      { type: "plain_text", name: "KITSHN_ACCESS_TEAM_DOMAIN", text: "own.example.com" },
      { type: "secret_text", name: "GITHUB_TOKEN", text: "t" },
      { type: "plain_text", name: "KITSHN_ACCESS_AUDIENCES", text: "aud-1,aud-2" },
    ]);
    expect(result.metadata["assets"]).toEqual({
      jwt: "j",
      config: { html_handling: "auto-trailing-slash", run_worker_first: ["/api/*"] },
    });
  });

  it("refuses a secret with the name of a binding, and a KV binding without its namespace", () => {
    const app = { main: "worker.js", compatibilityDate: "2026-10-01", kv: ["STATS"] };
    const base = { kv: new Map([["STATS", "ns-1"]]), secrets: {}, access, assets: null };
    expect(workerMetadata(app, { ...base, secrets: { STATS: "x" } })).toEqual({
      error: expect.stringMatching(/STATS/),
    });
    expect(workerMetadata(app, { ...base, kv: new Map() })).toEqual({
      error: expect.stringMatching(/missing/),
    });
  });

  it("takes only KITSHN_<NAME> style names and values of at most 5 KB as secrets", () => {
    expect(parseWorkerSecrets({ GITHUB_TOKEN: "t" })).toEqual({ secrets: { GITHUB_TOKEN: "t" } });
    expect(parseWorkerSecrets({ "bad-name": "t" })).toHaveProperty("error");
    expect(parseWorkerSecrets({ BIG: "x".repeat(6000) })).toHaveProperty("error");
  });
});

describe("card ids of several apps (K-804)", () => {
  it("keeps the ids of the app `app`, and puts every other key after the repo id", () => {
    expect(environmentNames("568822911", "Yarden-zamir/me", "prod")).toEqual(
      environmentNames("568822911", "Yarden-zamir/me", "prod", "app"),
    );
    expect(environmentNames("568822911", "Yarden-zamir/me", "prod").resourceId).toBe("app-me-568822911-prod");
    expect(environmentNames("568822911", "Yarden-zamir/me", "pr-31", "cv")).toEqual({
      resourceId: "app-me-568822911-cv-pr-31",
      script: "kitshn-app-me-568822911-cv-pr-31",
    });
  });

  it("hashes a long id within 56 characters, apart from the same environment of another app", () => {
    const long = environmentNames(
      "1234567890",
      "Yarden-zamir/trek-site-template-gr52x",
      "pr-1234",
      "statsdashboard",
    );
    expect(long.resourceId).toMatch(/^app-trek-site-template-g-1234567890-[0-9a-f]{8}$/);
    expect(long.script.length).toBeLessThanOrEqual(63);
    const other = environmentNames(
      "1234567890",
      "Yarden-zamir/trek-site-template-gr52x",
      "pr-1234",
      "statsdashboarx",
    );
    expect(other.resourceId).not.toBe(long.resourceId);
  });
});

describe("Compose results for rollback (K-820, K-821)", () => {
  it("keeps only image ids from a job result", () => {
    const id = `sha256:${"a".repeat(64)}`;
    expect(keptImages({ app: id, cache: "not-an-id", other: 3 })).toBe(JSON.stringify({ app: id }));
    expect(keptImages({ app: "x" })).toBeNull();
    expect(keptImages(null)).toBeNull();
  });

  it("takes the error that a failed job names at the end of its output", () => {
    expect(jobError("$ docker compose up\n...\n[kitshn: the app opened no socket within 3 minutes]")).toBe(
      "the app opened no socket within 3 minutes",
    );
    expect(jobError("killed")).toBe("The machine job failed.");
  });
});
