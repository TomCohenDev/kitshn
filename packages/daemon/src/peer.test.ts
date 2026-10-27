import { describe, expect, it } from "vitest";
import { localUsersOf, peerDecision } from "./peer.ts";

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
});
