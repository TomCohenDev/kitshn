import { describe, expect, it } from "vitest";
import { keyPlan } from "./keys.ts";

describe("key files on a challenge (K-1704 to K-1706)", () => {
  it("signs with machine.key when kitshn names it, and drops a rotation that kitshn never took", () => {
    expect(keyPlan("a", { current: "a", next: "b", fromCode: null })).toEqual({
      promote: null,
      dropNext: true,
    });
  });

  it("promotes a rotation or a key from a code that kitshn stored", () => {
    expect(keyPlan("b", { current: "a", next: "b", fromCode: null })).toEqual({
      promote: "next",
      dropNext: false,
    });
    expect(keyPlan("c", { current: "a", next: "b", fromCode: "c" })).toEqual({
      promote: "fromCode",
      dropNext: true,
    });
  });

  it("never removes a key from a code that waits for kitshn", () => {
    expect(keyPlan(null, { current: null, next: null, fromCode: "c" })).toEqual({
      promote: null,
      dropNext: false,
    });
    expect(keyPlan("a", { current: "a", next: null, fromCode: "c" }).promote).toBeNull();
  });
});
