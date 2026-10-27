import { describe, expect, it } from "vitest";
import { agentAllowRefusal, gateDecision } from "./repos.ts";

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
    expect(gateDecision(allowed, { ...repo, name: "o/renamed" }, 7).record).toMatchObject({ allowedBy: agent });
    expect(gateDecision(undefined, repo, 7).record).toMatchObject({ allowedBy: null });
  });
  it("lets an agent key allow only a waiting repo, and only with the right to add apps (K-718)", () => {
    const waiting = { ...repo, state: "waiting" as const, firstSeen: 1, allowedBy: null };
    expect(agentAllowRefusal(waiting, "allowed", true)).toBeNull();
    expect(agentAllowRefusal(waiting, "allowed", false)?.status).toBe(403);
    expect(agentAllowRefusal(waiting, "blocked", true)?.status).toBe(400);
    expect(agentAllowRefusal(undefined, "allowed", true)?.status).toBe(404);
    expect(agentAllowRefusal({ ...waiting, state: "blocked" }, "allowed", true)?.status).toBe(409);
    expect(agentAllowRefusal({ ...waiting, state: "allowed" }, "allowed", true)?.status).toBe(409);
  });
});
