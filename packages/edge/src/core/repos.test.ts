import { describe, expect, it } from "vitest";
import { gateDecision } from "./repos.ts";

const repo = { repoId: "42", name: "o/new" };

describe("the repo gate (K-819)", () => {
  it("lets a new repo wait for the owner, and records it once", () => {
    const first = gateDecision(undefined, repo, false, 7);
    expect(first).toMatchObject({ allow: false, record: { repoId: "42", state: "waiting", firstSeen: 7 } });
    const again = gateDecision({ ...repo, state: "waiting", firstSeen: 7 }, repo, false, 9);
    expect(again).toMatchObject({ allow: false, record: null });
  });
  it("allows a repo that deployed before the gate, and keeps its id", () => {
    expect(gateDecision(undefined, repo, true, 7)).toMatchObject({ allow: true, record: { state: "allowed" } });
  });
  it("refuses a blocked repo, also under a new name", () => {
    const blocked = { repoId: "42", name: "o/old", state: "blocked" as const, firstSeen: 1 };
    expect(gateDecision(blocked, { repoId: "42", name: "o/renamed" }, true, 7)).toMatchObject({
      allow: false,
      error: expect.stringMatching(/blocked/),
    });
  });
});
