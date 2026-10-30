import { describe, expect, it } from "vitest";
import { parseRange } from "../worker/restic.ts";
import { BACK_UP_NOW, backupFailureShown, nextBackupAt, pauseLimit, resticObject } from "./backups.ts";

const ID = "f".repeat(64);

describe("restic paths (K-1813)", () => {
  it("maps the protocol paths below the card, and refuses any other path", () => {
    expect(resticObject("app-x", "/config")).toEqual({ key: "backups/app-x/config" });
    expect(resticObject("app-x", "/snapshots/")).toEqual({ list: "backups/app-x/snapshots/" });
    expect(resticObject("app-x", `/data/${ID}`)).toEqual({ key: `backups/app-x/data/${ID}` });
    for (const path of ["/", "/other/", `/data/${ID}/x`, "/data/../config", "/data/ABC"])
      expect(resticObject("app-x", path)).toBeNull();
  });

  it("reads the two range forms that restic sends, and refuses the rest", () => {
    expect(parseRange("bytes=2-5")).toEqual({ offset: 2, length: 4 });
    expect(parseRange("bytes=7-")).toEqual({ offset: 7 });
    for (const header of ["bytes=-5", "bytes=5-2", "items=1-2", "bytes=1-2,4-5"])
      expect(parseRange(header)).toBeNull();
  });
});

describe("backup timing (K-1816, K-1817)", () => {
  it("lets the paused pass take 3 times the last one, from 30 to 90 seconds", () => {
    expect(pauseLimit(null)).toBe(90_000);
    expect(pauseLimit(5_000)).toBe(30_000);
    expect(pauseLimit(20_000)).toBe(60_000);
    expect(pauseLimit(55_000)).toBe(90_000);
  });

  it("starts the nightly backups at the next 03:00 UTC", () => {
    expect(nextBackupAt(Date.parse("2026-10-28T02:59:00Z"))).toBe(Date.parse("2026-10-28T03:00:00Z"));
    expect(nextBackupAt(Date.parse("2026-10-28T03:00:00Z"))).toBe(Date.parse("2026-10-29T03:00:00Z"));
  });
});

describe("the backup failed sticker (K-1819, K-538)", () => {
  it("hides only while a failed Back up now says the same", () => {
    const failed = { state: "failed" } as const;
    const action = (name: string, state: string) => ({ action: name, outcome: { state } });
    expect(backupFailureShown(failed, action(BACK_UP_NOW, "failed"))).toBe(false);
    // A daily backup has no action, and a newer action on the card replaces the failed one.
    expect(backupFailureShown(failed, null)).toBe(true);
    expect(backupFailureShown(failed, action("Deploy", "running"))).toBe(true);
    expect(backupFailureShown({ state: "done" }, action(BACK_UP_NOW, "failed"))).toBe(true);
  });
});
