import { describe, expect, it } from "vitest";
import { cookieValues } from "./auth.ts";

describe("Access cookies of a content host (K-1004)", () => {
  it("reads every CF_Authorization cookie, so another one first in the header does not hide the login", () => {
    expect(cookieValues("a=1; CF_Authorization=old; b=2; CF_Authorization=new", "CF_Authorization")).toEqual([
      "old",
      "new",
    ]);
    expect(cookieValues(null, "CF_Authorization")).toEqual([]);
  });
});
