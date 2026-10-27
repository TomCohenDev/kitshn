import { describe, expect, it } from "vitest";
import { environmentNames, eventOf, parseManifest } from "./deploys.ts";

describe("deploys (K-811, K-903)", () => {
  it("takes the event, branch and pull request from the token, not from the request", () => {
    const push = { eventName: "push", branch: "feature-x", pr: null };
    expect(eventOf(push, { name: "push", branch: "main", action: "closed" })).toEqual({
      name: "push",
      branch: "feature-x",
      pr: null,
      action: null,
    });
    const pull = { eventName: "pull_request", branch: "x", pr: 7 };
    expect(eventOf(pull, { action: "closed", pr: 1 })).toEqual({ name: "pull_request", branch: "x", pr: 7, action: "closed" });
    expect(eventOf({ eventName: "workflow_dispatch", branch: "main", pr: null }, {})).toMatch(/push and pull_request/);
  });

  it("keeps repos with similar names apart", () => {
    expect(environmentNames("1", "me/my.site", "prod").script).not.toBe(environmentNames("2", "me/my-site", "prod").script);
    expect(environmentNames("1", "me/hello", "prod").script.length).toBeLessThanOrEqual(63);
    const long = (env: string) => environmentNames("1061234567", "me/a-fairly-long-repository-name", env).resourceId;
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
});
