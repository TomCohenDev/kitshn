import { describe, expect, it } from "vitest";
import { headersWarnings } from "./headers.ts";

describe("_headers limits (K-805)", () => {
  it("warns about more than 100 rules and lines over 2,000 characters, and counts no comment or header line", () => {
    const rule = (index: number) => `/p${index}\n  Cache-Control: no-cache\n`;
    expect(headersWarnings(`# comment\n${rule(1)}`)).toEqual([]);
    expect(headersWarnings(Array.from({ length: 100 }, (_, index) => rule(index)).join(""))).toEqual([]);
    expect(headersWarnings(Array.from({ length: 101 }, (_, index) => rule(index)).join(""))).toEqual([
      expect.stringContaining("101 rules"),
    ]);
    expect(headersWarnings(`/a\n  X-Long: ${"x".repeat(2000)}\n`)).toEqual([
      expect.stringContaining("line 2"),
    ]);
  });
});
