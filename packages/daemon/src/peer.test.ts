import { describe, expect, it } from "vitest";
import { localUsersOf, peerDecision, requestAllowed } from "./peer.ts";

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
      expect(requestAllowed("status", uid, own)).toBe(true);
      expect(requestAllowed("rotate-key", uid, own)).toBe(true);
      expect(requestAllowed("reconnect", uid, own)).toBe(true);
    }
    expect(requestAllowed("status", 1001, own)).toBe(true);
    expect(requestAllowed("rotate-key", 1001, own)).toBe(false);
    // K-1751: an attester vouches for threads, so a user in localUsers cannot register one.
    expect(requestAllowed("attester-set", 1001, own)).toBe(false);
    expect(requestAllowed("attester-set", own, own)).toBe(true);
    expect(requestAllowed("attester-set", 0, own)).toBe(true);
    expect(requestAllowed("reconnect", 1001, own)).toBe(false);
    // K-1710: a local user asks kitshn as the machine.
    expect(requestAllowed("ask", 1001, own)).toBe(true);
  });
});
