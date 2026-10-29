import { describe, expect, it } from "vitest";
import { forwardTarget, passedHeaders, readBounded } from "./forward.ts";

const server = "https://kit.example.com";

describe("calls that the daemon forwards (K-1714)", () => {
  it("sends only paths that stay below /agent/ on the server, also after decoding", () => {
    expect(String(forwardTarget(server, "/agent/library?x=1"))).toBe(
      "https://kit.example.com/agent/library?x=1",
    );
    for (const path of [
      "/agent/../connect/deploys/1/params.env",
      "/agent/%2e%2e/connect/backups/card/key",
      "/agent/cards/a%2f..%2f..%2fconnect/address",
      "/agent/cards/a%252e%252e/address",
      "//evil.example.com/agent/library",
      "https://evil.example.com/agent/library",
      "/api/proposals/1/deny",
    ])
      expect(forwardTarget(server, path), path).toEqual(expect.any(String));
  });

  it("drops the caller's copies of the daemon's own headers, in any case", () => {
    expect(
      passedHeaders({
        "X-Kitshn-Name": "page.html",
        "content-type": "text/html",
        "X-KITSHN-MACHINE-SIGNATURE": "forged",
        "x-kitshn-attested": "{}",
        "cf-access-client-id": "other",
      }),
    ).toEqual({ "X-Kitshn-Name": "page.html", "content-type": "text/html" });
  });

  it("stops reading an answer at the limit", async () => {
    expect((await readBounded(new Response("12345"), 5)).toString()).toBe("12345");
    await expect(readBounded(new Response("123456"), 5)).rejects.toThrow(/more than 5 bytes/);
  });
});
