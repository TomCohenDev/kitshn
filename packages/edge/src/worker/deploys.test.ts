import { describe, expect, it } from "vitest";
import { environmentNames, eventOf, legacyRepos, parseManifest, parseSiteIcon, repoIdOf } from "./deploys.ts";

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
});
