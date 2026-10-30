import { describe, expect, it } from "vitest";
import { localUsersOf, peerDecision, providerUsersOf, requestAllowed } from "./peer.ts";

describe("peer user check (K-701)", () => {
  it("lets in the daemon user and the listed local users only", () => {
    expect(peerDecision(1000, 1000, [])).toEqual({ accept: true });
    expect(peerDecision(0, 1000, [0])).toEqual({ accept: true });
    expect(peerDecision(0, 1000, [])).toMatchObject({ accept: false });
    expect(peerDecision(1001, 1000, [0])).toMatchObject({ accept: false });
  });

  it("refuses every peer when it cannot read the list (K-006)", () => {
    expect(peerDecision(1000, 1000, null)).toMatchObject({ accept: false });
  });
});

describe("local users in machine.json (K-701)", () => {
  it("reads the list, none without one, and null for a broken one", () => {
    expect(localUsersOf({ machineId: "m1", localUsers: [0] })).toEqual([0]);
    expect(localUsersOf({ machineId: "m1" })).toEqual([]);
    expect(localUsersOf({ localUsers: ["root"] })).toBeNull();
    expect(localUsersOf({ localUsers: [-1] })).toBeNull();
  });

  it("lets a local user read the status only; the admin requests stay with the daemon user and root", () => {
    const own = 1000;
    for (const uid of [own, 0]) {
      expect(requestAllowed("status", uid, own, [])).toBe(true);
      expect(requestAllowed("rotate-key", uid, own, [])).toBe(true);
      expect(requestAllowed("reconnect", uid, own, [])).toBe(true);
    }
    expect(requestAllowed("status", 1001, own, [])).toBe(true);
    expect(requestAllowed("rotate-key", 1001, own, [])).toBe(false);
    // K-1751: an attester vouches for threads, so a user in localUsers cannot register one.
    expect(requestAllowed("attester-set", 1001, own, [])).toBe(false);
    expect(requestAllowed("attester-set", own, own, [])).toBe(true);
    expect(requestAllowed("attester-set", 0, own, [])).toBe(true);
    expect(requestAllowed("reconnect", 1001, own, [])).toBe(false);
    // K-1710: a local user asks kitshn as the machine.
    expect(requestAllowed("ask", 1001, own, [])).toBe(true);
    // K-1612, K-605: a local user cancels the machine's own queued jobs and reads its samples.
    expect(requestAllowed("job-cancel", 1001, own, [])).toBe(true);
    expect(requestAllowed("samples", 1001, own, [])).toBe(true);
    // K-704: a provider adds cards and enforces their grants, so only the daemon user and root are providers.
    for (const type of [
      "register",
      "upsert",
      "remove",
      "command-result",
      "provider-forget",
      "desired-set",
    ] as const) {
      expect(requestAllowed(type, 1001, own, [])).toBe(false);
      expect(requestAllowed(type, own, own, [])).toBe(true);
      expect(requestAllowed(type, 0, own, [])).toBe(true);
    }
  });

  it("lets a provider user run a provider and its attester, and nothing of the machine admin (K-701)", () => {
    const own = 1000;
    // A plain local user stays narrow; a provider user also sends the provider requests and `attester-set`.
    for (const type of [
      "register",
      "upsert",
      "remove",
      "command-result",
      "desired-set",
      "audit",
      "attester-set",
    ] as const) {
      expect(requestAllowed(type, 1001, own, [1002])).toBe(false);
      expect(requestAllowed(type, 1002, own, [1002])).toBe(true);
    }
    for (const type of ["provider-forget", "provider-rebind", "rotate-key", "reconnect"] as const)
      expect(requestAllowed(type, 1002, own, [1002])).toBe(false);
    // Only a user that `localUsers` still holds keeps the provider right; a file that cannot be read gives none.
    expect(providerUsersOf({ localUsers: [1001, 1002], providerUsers: [1002, 1003] })).toEqual([1002]);
    expect(providerUsersOf({ localUsers: ["t3"], providerUsers: [1002] })).toEqual([]);
  });
});
