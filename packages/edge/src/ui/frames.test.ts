import { describe, expect, it } from "vitest";
import { frameSandbox } from "./frames.ts";

describe("frameSandbox (K-520)", () => {
  it("never frames the admin host, and gives pages and files no allow-same-origin", () => {
    expect(
      ["kit.example.com", "pages.example.com/abc", "files.example.com/abc/a.png", "app.example.com"].map(
        (address) => frameSandbox(address, "kit.example.com", "example.com"),
      ),
    ).toEqual([null, "allow-scripts", "allow-scripts", "allow-scripts allow-same-origin allow-forms"]);
  });
});
