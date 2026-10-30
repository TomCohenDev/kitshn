import { describe, expect, it } from "vitest";
import { refusalText } from "./refusal.ts";

const PREFIX = "The request does not match K-702:";

describe("refusalText", () => {
  it.each([
    [
      `${PREFIX} Expected a value with a length of at most 64 at ["resources"][0]["lists"][0]["rows"][4]["id"]`,
      "t3 on Mac sent a list row id over 64 characters. Update t3 on Mac.",
    ],
    [
      `${PREFIX} Expected a value with a length of at most 200 at ["resources"][0]["name"]`,
      "t3 on Mac sent a value over the limit of 200. Update t3 on Mac.",
    ],
    [
      `${PREFIX} Expected string, got 5 at ["resources"][0]["name"]`,
      "t3 on Mac sent a value that kitshn does not accept. Update t3 on Mac.",
    ],
    // Not a schema error: the daemon's own words name the way out, so they stay.
    [
      "The name t3 belongs to another user. Run kitshn providers rebind t3 --to-user me.",
      "The name t3 belongs to another user. Run kitshn providers rebind t3 --to-user me.",
    ],
    ["", ""],
  ])("%s", (reason, text) => {
    expect(refusalText("t3", "Mac", reason)).toBe(text);
  });
});
