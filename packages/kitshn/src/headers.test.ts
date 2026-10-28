import { describe, expect, it } from "vitest";
import { headersWarnings, redirectsWarnings } from "./headers.ts";

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

describe("_redirects limits (K-805)", () => {
  it("counts static and dynamic rules apart, skips comments, and warns about long lines", () => {
    const site = "# old links\n/github https://github.com/x 301\n/git/* https://github.com/x/:splat 301\n";
    expect(redirectsWarnings(site)).toEqual([]);
    const dynamic = Array.from({ length: 101 }, (_, index) => `/p${index}/* /q 301`).join("\n");
    expect(redirectsWarnings(dynamic)).toEqual([expect.stringContaining("101 dynamic rules")]);
    const staticRules = Array.from({ length: 2001 }, (_, index) => `/p${index} /q 301`).join("\n");
    expect(redirectsWarnings(staticRules)).toEqual([expect.stringContaining("2001 static rules")]);
    expect(redirectsWarnings(`/a /${"x".repeat(1000)} 301`)).toEqual([expect.stringContaining("line 1")]);
    // A tab separates fields too: a static source with a tab, then a target that holds a colon, stays static.
    const tabbed = Array.from({ length: 101 }, (_, index) => `/p${index}\thttps://example.com/q\t301`).join(
      "\n",
    );
    expect(redirectsWarnings(tabbed)).toEqual([]);
  });
});
