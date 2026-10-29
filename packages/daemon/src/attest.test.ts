import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attest,
  attestationRefusal,
  attestedLabels,
  attesterPrefixes,
  attestersOf,
  dropAttested,
  unregisteredT3,
  withAttester,
} from "./attest.ts";

afterEach(() => vi.restoreAllMocks());

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

describe("attester answers and registration (K-1751, K-1752)", () => {
  const t3 = {
    prefix: "t3.",
    address: "http://127.0.0.1:3773/api/thread-identity",
    tokenEnv: "T3_ACP_MCP_AUTHORIZATION",
  };

  it("refuses a call whose token the attester cannot check or calls inactive; it never goes as the bare machine", async () => {
    const answer = (response: Response) => vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
    answer(Response.json({ active: true, threadId: "th" }));
    expect(await attest(t3, "token")).toEqual({ outcome: "labels", labels: { "t3.thread.id": "th" } });
    answer(Response.json({ active: false }));
    const inactive = await attest(t3, "token");
    expect(attestationRefusal(t3, inactive)).toMatch(/T3 thread of this call is not active/);
    answer(new Response("down", { status: 502 }));
    const failed = await attest(t3, "token");
    expect(attestationRefusal(t3, failed)).toBe("could not check the T3 thread; try again.");
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("timeout"));
    expect(await attest(t3, "token")).toEqual({ outcome: "failed" });
  });

  it("writes an attester over the older entry of its prefix and keeps the rest of machine.json", () => {
    const machine = {
      clientSecret: "s",
      attesters: [
        { ...t3, address: "http://127.0.0.1:1/old" },
        { prefix: "x.", address: "http://[::1]:2/", tokenEnv: "X" },
      ],
    };
    expect(withAttester(machine, t3)).toEqual({
      clientSecret: "s",
      attesters: [{ prefix: "x.", address: "http://[::1]:2/", tokenEnv: "X" }, t3],
    });
    expect(withAttester(machine, { ...t3, address: "http://example.com/x" })).toMatch(/not on loopback/);
    expect(withAttester(machine, { ...t3, address: "file://localhost/etc/passwd" })).toMatch(
      /not an http or https/,
    );
    // The registering user's uid stays with the entry, so each check can compare the port's user again.
    expect(attestersOf(withAttester(machine, { ...t3, uid: 501 })).attesters).toContainEqual({
      ...t3,
      uid: 501,
    });
  });

  it("refuses the T3 credential on a machine where no t3. attester is registered, and lets a call without it pass", () => {
    const token = { T3_ACP_MCP_AUTHORIZATION: "Bearer x" };
    expect(unregisteredT3(token, [])).toMatch(/T3 server has not registered/);
    expect(unregisteredT3(token, [t3])).toBeNull();
    expect(unregisteredT3({}, [])).toBeNull();
  });
});
