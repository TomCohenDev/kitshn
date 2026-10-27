import { describe, expect, it } from "vitest";
import { kitshn1Deployment } from "./kitshn1.ts";

describe("KitSHn 1 data of a moving app (K-1404)", () => {
  it("names the folder and the Compose project as KitSHn 1 did", () => {
    expect(kitshn1Deployment("Yarden-zamir/money", "prod", "/persistent")).toEqual({
      dataDir: "/persistent/Yarden-zamir/money/prod",
      project: "yarden-zamir-money-prod",
    });
    expect(kitshn1Deployment("Owner/My.App", "pr-7", "/p")?.project).toBe("owner-my-app-pr-7");
  });
  it("refuses names that would leave the persistent root", () => {
    for (const repo of ["../x", "a/..", "a/b/c", "a", "a/b c"]) expect(kitshn1Deployment(repo, "prod", "/p")).toBeNull();
    expect(kitshn1Deployment("a/b", "..", "/p")).toBeNull();
  });
});
