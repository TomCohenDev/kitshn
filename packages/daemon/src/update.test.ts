import { describe, expect, it } from "vitest";
import { type UpdateMarker, oldBinaries, restorePrevious, startStep, swapBinary } from "./update.ts";

/** Files by name; `busy` names files whose rename fails that many times. */
function folder(names: ReadonlyArray<string>, busy: Record<string, number> = {}) {
  const files = new Set(names);
  const left = { ...busy };
  return {
    files,
    rename(from: string, to: string) {
      if ((left[from] ?? 0) > 0) {
        left[from] = (left[from] ?? 0) - 1;
        throw new Error(`EBUSY ${from}`);
      }
      if (!files.has(from)) throw new Error(`ENOENT ${from}`);
      files.delete(from);
      files.add(to);
    },
  };
}
const none = async () => {};

describe("the binary swap of an update (K-620)", () => {
  it("puts the new binary in place and keeps the old one", async () => {
    const files = folder(["k.exe", "k.exe.new"]);
    await swapBinary(files, "k.exe", "k.exe.new", "k.old-1.exe", 5, none);
    expect([...files.files].sort()).toEqual(["k.exe", "k.old-1.exe"]);
  });

  it("tries again while a scan holds the new file", async () => {
    const files = folder(["k.exe", "k.exe.new"], { "k.exe.new": 3 });
    await swapBinary(files, "k.exe", "k.exe.new", "k.old-1.exe", 5, none);
    expect(files.files.has("k.exe")).toBe(true);
  });

  it("puts the old binary back when the new one never goes in place, so the task finds a binary", async () => {
    const files = folder(["k.exe", "k.exe.new"], { "k.exe.new": 99 });
    await expect(swapBinary(files, "k.exe", "k.exe.new", "k.old-1.exe", 5, none)).rejects.toThrow(
      /the old one is back/,
    );
    expect(files.files.has("k.exe")).toBe(true);
    expect(files.files.has("k.old-1.exe")).toBe(false);
  });

  it("finds only the old copies of its own binary, and keeps the newest as the way back (K-629)", () => {
    expect(
      oldBinaries("/p/kitshn.exe", [
        "kitshn.exe",
        "kitshn.old-10.exe",
        "kitshn.old-9.exe",
        "kitshn.old-2.exe",
        "other.old-1.exe",
      ]),
    ).toEqual(["/p/kitshn.old-2.exe", "/p/kitshn.old-9.exe"]);
  });
});

describe("the way back of an update (K-629)", () => {
  const marker: UpdateMarker = {
    jobId: 7,
    from: "bbbbbbbbbbbb",
    to: "aaaaaaaaaaaa",
    previous: "/p/kitshn.old",
    deadline: 1000,
    state: "pending",
  };

  it("waits for kitshn before the deadline, and rolls back at the first start after it", () => {
    expect(startStep(marker, marker.to, 999)).toEqual({ kind: "wait", jobId: 7, deadline: 1000 });
    expect(startStep(marker, marker.to, 1000)).toEqual({
      kind: "roll-back",
      reason: "The new daemon did not reach kitshn within 5 minutes.",
    });
  });

  it("puts the previous binary back on Linux and macOS, and the previous daemon reports why", async () => {
    const files = folder(["/p/kitshn", "/p/kitshn.old"]);
    await restorePrevious(files, "/p/kitshn", marker.previous, false, 2000, none);
    expect([...files.files]).toEqual(["/p/kitshn"]);
    const back = { ...marker, state: "rolled-back" as const, reason: "The new daemon crashed." };
    expect(startStep(back, marker.from, 2000)).toEqual({
      kind: "report",
      jobId: 7,
      reason: "The new daemon crashed.",
    });
  });

  it("swaps the previous .exe back on Windows, keeping the failed one aside (K-620)", async () => {
    const files = folder(["k.exe", "k.old-1.exe"]);
    await restorePrevious(files, "k.exe", "k.old-1.exe", true, 2, none);
    expect([...files.files].sort()).toEqual(["k.exe", "k.old-2.exe"]);
  });
});
