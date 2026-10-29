import { describe, expect, it } from "vitest";
import { attestedLabels, attesterPrefixes, attestersOf, dropAttested } from "./attest.ts";

describe("attesters (K-1751 to K-1755)", () => {
  it("takes only loopback attesters from machine.json, and keeps t3. reserved", () => {
    const { attesters, refused } = attestersOf({
      attesters: [
        {
          prefix: "t3.",
          address: "http://127.0.0.1:3773/api/thread-identity",
          tokenEnv: "T3_ACP_MCP_AUTHORIZATION",
        },
        { prefix: "ci.", address: "https://example.com/who", tokenEnv: "CI_TOKEN" },
      ],
    });
    expect(attesters.map((attester) => attester.prefix)).toEqual(["t3."]);
    expect(refused).toEqual([expect.stringContaining("not on loopback")]);
    expect(attesterPrefixes([])).toEqual(["t3."]);
  });

  it("drops a caller's label with an attester prefix", () => {
    expect(dropAttested({ "t3.thread.id": "x", "my.note": "kept" }, ["t3."])).toEqual({ "my.note": "kept" });
  });

  it("maps an active T3 answer to its labels, and gives none for an inactive one", () => {
    expect(
      attestedLabels("t3.", {
        active: true,
        threadId: "abc",
        threadTitle: "Fix login",
        subagent: false,
        parentThreadId: null,
        checkedAt: "2026-10-29T00:00:00Z",
      }),
    ).toEqual({
      "t3.thread.id": "abc",
      "t3.thread.title": "Fix login",
      "t3.subagent": "false",
      "t3.thread.parent": "",
    });
    expect(attestedLabels("t3.", { active: false })).toBeNull();
  });
});
