import { describe, expect, it } from "vitest";
import { ASK_ACTIONS as LOCAL_ACTIONS } from "../../../local/src/index.ts";
import { ASK_ACTIONS, askRequest, labelProblem, rightWarnings } from "./asks.ts";
import type { Circle } from "./model.ts";

describe("asks of agents on machines (K-1710, K-1711, K-1750)", () => {
  it("knows the same actions as the daemon", () => {
    expect([...ASK_ACTIONS]).toEqual([...LOCAL_ACTIONS]);
  });

  it("takes at most 10 labels with a prefixed key and a short text value", () => {
    expect(labelProblem(undefined)).toBeNull();
    expect(labelProblem({ "t3.thread.id": "abc" })).toBeNull();
    for (const bad of [
      { thread: "no prefix" },
      { "T3.thread": "capital" },
      { "t3.thread": 5 },
      { "t3.thread": "x".repeat(257) },
      Object.fromEntries(Array.from({ length: 11 }, (_, at) => [`a.${at}`, "x"])),
      ["a.b"],
    ])
      expect(labelProblem(bad)).toEqual(expect.any(String));
  });

  it("maps each action that kitshn runs through an agent path to that path", () => {
    expect(askRequest("allow", "123", null)).toEqual({
      method: "POST",
      path: "/agent/repos/123",
      body: { state: "allowed" },
    });
    expect(askRequest("deploy", "card", { mode: "build" })).toMatchObject({
      body: { card: "card", mode: "build" },
    });
    expect(askRequest("deploy", "card", {})).toMatchObject({ body: { mode: "redeploy" } });
    expect(askRequest("approve", "id", null)).toEqual(expect.any(String));
  });
});

describe("warnings of machine rights (K-1725)", () => {
  const circle = (id: string, members: Circle["members"]): Circle => ({
    id,
    name: id,
    color: "#000000",
    level: "control",
    members,
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 0,
    y: 0,
    r: 1,
  });
  const circles = new Map([
    ["owner", circle("owner", [{ _tag: "email", email: "o@example.com" }])],
    ["bots", circle("bots", [{ _tag: "machine", machineId: "vps" }])],
  ]);

  it("warns and allows: self-approval, no person for a high-risk right, agent approvers, automatic code writes", () => {
    expect(rightWarnings(circles, "vps", { runsCommands: { mode: "ask", circleId: "owner" } })).toEqual([]);
    const warnings = rightWarnings(circles, "vps", {
      runsCommands: { mode: "ask", circleId: "bots" },
      writesCode: { mode: "automatic" },
    });
    expect(warnings).toHaveLength(4);
    expect(warnings.join(" ")).toMatch(/approve itself/);
  });
});
