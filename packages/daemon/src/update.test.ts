import { describe, expect, it } from "vitest";
import { oldBinaries, swapBinary } from "./update.ts";

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

  it("finds only the old copies of its own binary", () => {
    expect(
      oldBinaries("/p/kitshn.exe", ["kitshn.exe", "kitshn.old-1.exe", "kitshn.old-2.exe", "other.old-1.exe"]),
    ).toEqual(["/p/kitshn.old-1.exe", "/p/kitshn.old-2.exe"]);
  });
});
