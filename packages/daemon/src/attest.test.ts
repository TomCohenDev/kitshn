import { describe, expect, it } from "vitest";
import { attesterPrefixes, dropAttested } from "./attest.ts";

describe("labels that only an attester sets (K-1753)", () => {
  it("drops a caller's label with an attester prefix, also the reserved t3. before T3 is listed", () => {
    const prefixes = attesterPrefixes({ attesters: [{ prefix: "ci." }] });
    expect(prefixes).toEqual(["t3.", "ci."]);
    expect(dropAttested({ "t3.thread.id": "x", "ci.run": "1", "my.note": "kept" }, prefixes)).toEqual({
      "my.note": "kept",
    });
    expect(attesterPrefixes(null)).toEqual(["t3."]);
  });
});
