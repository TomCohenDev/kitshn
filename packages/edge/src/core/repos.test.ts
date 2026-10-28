import { describe, expect, it } from "vitest";
import { agentAllowRefusal, awaitsAllow, forgetRefusal, gateDecision, keyRemoved } from "./repos.ts";

const repo = { repoId: "42", name: "o/new", branch: "main" };

describe("the repo gate (K-819)", () => {
  it("lets a new repo wait for the owner and keeps its first pushed branch", () => {
    const first = gateDecision(undefined, repo, 7);
    expect(first).toMatchObject({
      allow: false,
      record: { repoId: "42", state: "waiting", branch: "main", firstSeen: 7 },
    });
    const waiting = { ...repo, state: "waiting" as const, firstSeen: 7, allowedBy: null };
    expect(gateDecision(waiting, { ...repo, branch: "other" }, 9)).toMatchObject({
      allow: false,
      record: null,
    });
    // A pull request run records no branch; the next push does.
    const noBranch = { ...waiting, branch: null };
    expect(gateDecision(noBranch, { ...repo, branch: null }, 9).record).toBeNull();
    expect(gateDecision(noBranch, { ...repo, branch: "dev" }, 9).record).toMatchObject({ branch: "dev" });
  });
  it("lets an allowed repo deploy and drops a branch that Allow could not start", () => {
    const allowed = { ...repo, state: "allowed" as const, firstSeen: 1, allowedBy: null };
    expect(gateDecision(allowed, repo, 7)).toMatchObject({ allow: true, record: { branch: null } });
    expect(gateDecision({ ...allowed, branch: null }, repo, 7)).toEqual({ allow: true, record: null });
  });
  it("refuses a blocked repo, also under a new name, and records the new name", () => {
    const blocked = {
      repoId: "42",
      name: "o/old",
      state: "blocked" as const,
      firstSeen: 1,
      branch: null,
      allowedBy: null,
    };
    expect(gateDecision(blocked, { repoId: "42", name: "o/renamed", branch: null }, 7)).toMatchObject({
      allow: false,
      record: { name: "o/renamed", state: "blocked" },
      error: expect.stringMatching(/blocked/),
    });
  });
  it("keeps the agent key that allowed a repo when a deploy step writes the row", () => {
    const agent = { clientId: "agent-1", name: "Builder" };
    const allowed = { ...repo, state: "allowed" as const, firstSeen: 1, allowedBy: agent };
    expect(gateDecision(allowed, { ...repo, name: "o/renamed" }, 7).record).toMatchObject({
      allowedBy: agent,
    });
    expect(gateDecision(undefined, repo, 7).record).toMatchObject({ allowedBy: null });
  });
  it("lets an agent key allow only a waiting repo, and only with the right to add apps (K-718)", () => {
    const waiting = { ...repo, state: "waiting" as const, firstSeen: 1, allowedBy: null };
    expect(agentAllowRefusal(waiting, "allowed", true, false)).toBeNull();
    expect(agentAllowRefusal(waiting, "allowed", false, false)?.status).toBe(403);
    expect(agentAllowRefusal(waiting, "blocked", true, false)?.status).toBe(400);
    expect(agentAllowRefusal(undefined, "allowed", true, false)?.status).toBe(404);
    expect(agentAllowRefusal({ ...waiting, state: "blocked" }, "allowed", true, false)?.status).toBe(409);
    expect(agentAllowRefusal({ ...waiting, state: "allowed" }, "allowed", true, false)?.status).toBe(409);
    // A repo that GitHub deleted is not waiting for anyone, as /agent/state leaves it out.
    expect(agentAllowRefusal(waiting, "allowed", true, true)?.status).toBe(409);
  });
  it("lets a repo wait again while the agent key that allowed it has no agent circle", () => {
    const agent = { clientId: "agent-1", name: "Builder" };
    const allowed = { ...repo, state: "allowed" as const, firstSeen: 1, branch: null, allowedBy: agent };
    expect(keyRemoved(allowed, () => true)).toBe(false);
    expect(keyRemoved(allowed, () => false)).toBe(true);
    expect(keyRemoved({ ...allowed, allowedBy: null }, () => false)).toBe(false);
    expect(keyRemoved({ ...allowed, state: "blocked" }, () => false)).toBe(false);
    // The row stays allowed, so the repo deploys again when the key comes back; the push waits for Take over.
    expect(gateDecision(allowed, repo, 7, true)).toMatchObject({
      allow: false,
      record: { state: "allowed", allowedBy: agent, branch: "main" },
      error: expect.stringMatching(/takes it over/),
    });
  });
  it("forgets a repo without cards, a blocked one only after GitHub deleted it, and a forgotten repo waits again", () => {
    const base = { name: "o/new", goneOnGitHub: false, keyRemoved: false };
    for (const state of ["waiting", "allowed"] as const) {
      expect(forgetRefusal({ ...base, state }, 0)).toBeNull();
      expect(forgetRefusal({ ...base, state }, 1)).toMatch(/Remove app/);
    }
    // Forget would let an agent key with "adds apps" allow a repo that the owner blocked.
    expect(forgetRefusal({ ...base, state: "blocked" }, 0)).toMatch(/blocked/);
    expect(forgetRefusal({ ...base, state: "blocked", goneOnGitHub: true }, 0)).toBeNull();
    expect(forgetRefusal({ ...base, state: "blocked", goneOnGitHub: true }, 2)).toMatch(/Remove app/);
    // The same for a repo whose agent key was removed: Take over or Block it first.
    expect(forgetRefusal({ ...base, state: "allowed", keyRemoved: true }, 0)).toMatch(/Take it over/);
    expect(forgetRefusal({ ...base, state: "allowed", keyRemoved: true, goneOnGitHub: true }, 0)).toBeNull();
    // Forget drops the row, so the next deploy finds none: it waits, with no agent key.
    expect(gateDecision(undefined, repo, 9)).toMatchObject({
      allow: false,
      record: { state: "waiting", allowedBy: null },
    });
  });
  it("counts a repo as waiting only while the owner can allow it", () => {
    const view = { state: "waiting" as const, keyRemoved: false, goneOnGitHub: false };
    expect(awaitsAllow(view)).toBe(true);
    expect(awaitsAllow({ ...view, keyRemoved: true })).toBe(false);
    expect(awaitsAllow({ ...view, goneOnGitHub: true })).toBe(false);
    expect(awaitsAllow({ ...view, state: "allowed" })).toBe(false);
    expect(awaitsAllow({ ...view, state: "blocked" })).toBe(false);
  });
});
