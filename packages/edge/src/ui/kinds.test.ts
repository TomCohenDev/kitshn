import { describe, expect, it } from "vitest";
import { LEVELS } from "../core/model.ts";
import { LEVEL_LINES } from "./kinds.ts";

describe("lens lines by level (K-537)", () => {
  it("draws a higher level with a heavier line, and only a look-only share dashed", () => {
    const widths = LEVELS.map((level) => LEVEL_LINES[level].width);
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
    expect(new Set(widths).size).toBe(LEVELS.length);
    expect(LEVELS.filter((level) => LEVEL_LINES[level].dash !== null)).toEqual(["view"]);
  });
});
