import { describe, expect, it } from "vitest";
import { cardOutput, errorOutput } from "./output.ts";

describe("--json output (K-1116, K-1120, K-1123)", () => {
  it("prints one JSON object per line: the card, or the error", () => {
    const card = JSON.parse(
      cardOutput({ address: "pages.example.com/a", card: "x", kind: "page", updated: false, revision: 3 }),
    ) as Record<string, unknown>;
    expect(Object.keys(card).sort()).toEqual(["address", "card", "kind", "revision", "updated"]);
    expect(
      cardOutput({ address: "a.example.com", card: "folder-x", kind: "folder", updated: true }).split("\n"),
    ).toEqual(['{"address":"a.example.com","card":"folder-x","kind":"folder","updated":true}', ""]);
    expect(JSON.parse(errorOutput("no right"))).toEqual({ error: "no right" });
  });
});
