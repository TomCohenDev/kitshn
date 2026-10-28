import { describe, expect, it } from "vitest";
import { cookieValues, workflowFile } from "./auth.ts";

describe("Access cookies of a content host (K-1004)", () => {
  it("reads every CF_Authorization cookie, so another one first in the header does not hide the login", () => {
    expect(cookieValues("a=1; CF_Authorization=old; b=2; CF_Authorization=new", "CF_Authorization")).toEqual([
      "old",
      "new",
    ]);
    expect(cookieValues(null, "CF_Authorization")).toEqual([]);
  });
});

describe("workflowFile (K-1121)", () => {
  it("reads the workflow file of the run from workflow_ref, and nothing else", () => {
    expect(workflowFile("o/r/.github/workflows/kitshn-site.yml@refs/heads/main", "o/r")).toBe(
      "kitshn-site.yml",
    );
    expect(workflowFile("o/r/.github/workflows/kitshn.yml@refs/pull/7/merge", "o/r")).toBe("kitshn.yml");
    // Another repo's workflow, a nested path or no claim gives none, so Allow starts kitshn.yml.
    expect(workflowFile("x/y/.github/workflows/kitshn.yml@refs/heads/main", "o/r")).toBeNull();
    expect(workflowFile("o/r/.github/workflows/a/b.yml@refs/heads/main", "o/r")).toBeNull();
    expect(workflowFile("", "o/r")).toBeNull();
  });
});
