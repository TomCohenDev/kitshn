import { describe, expect, it } from "vitest";
import { readApps } from "./parse.ts";
import { decodeApps, plan } from "./recipe.ts";
import { repoFiles } from "./repo-files.ts";

const push = { name: "push", branch: "main", pr: null, action: null } as const;

describe("kitshn repo files (K-1127)", () => {
  it("writes a recipe that plans to the card's addresses, also for a site on another zone", () => {
    for (const addresses of [["hand.example.com"], ["hand.example.com", "hand.example.org"]]) {
      const files = repoFiles(
        { card: "folder-x", kind: "folder", addresses },
        "owner/hand",
        "https://kit.example.com",
        "skill",
      );
      const apps = decodeApps(readApps(files["kitshn.config.ts"] ?? "")) as Record<
        string,
        Parameters<typeof plan>[0]
      >;
      const app = apps["app"];
      if (!app) throw new Error("The recipe has no app.");
      expect(plan(app, "owner/hand", push, "example.com", ["example.org"])).toMatchObject({
        kind: "deploy",
        address: "hand.example.com",
        addresses,
      });
    }
    const files = repoFiles(
      { card: "x", kind: "page", addresses: ["a.example.com"] },
      "owner/hand",
      "https://kit.example.com",
      "the skill",
    );
    expect(files["README.md"]).toContain("https://kit.example.com/public/badges/owner/hand.svg");
    // K-618: a new repo starts with its copy of the kitshn skill.
    expect(files[".claude/skills/kitshn/SKILL.md"]).toBe("the skill");
  });
});
