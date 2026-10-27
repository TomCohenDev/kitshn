import { describe, expect, it } from "vitest";
import { circlePolicies } from "../core/access.ts";
import { type Machine, newJoinCode, openJoin, sealJoin } from "../core/machine.ts";
import type { Circle } from "../core/model.ts";
import { circleMatches } from "../core/visitor.ts";
import { machineIdFor, parseCommand, parseLabels, pickMachine } from "./machines.ts";

const machine = (id: string, order: number, labels: Array<string>): Machine => ({
  id,
  name: id,
  labels,
  order,
  serviceTokenId: `token-${id}`,
  clientId: `${id}.access`,
  tunnelId: `tunnel-${id}`,
});

describe("join codes (K-602)", () => {
  it("opens with the right code and fails with another", async () => {
    const code = newJoinCode();
    const secrets = {
      server: "https://kit.example.com",
      machineId: "m1",
      clientId: "c",
      clientSecret: "s",
      tunnelToken: "t",
    };
    const box = await sealJoin(code, secrets);
    expect(await openJoin(code, box)).toEqual(secrets);
    await expect(openJoin(newJoinCode(), box)).rejects.toThrow();
  });
});

describe("jobs (K-610)", () => {
  it("picks the first online machine in the order that has every label", () => {
    const machines = [
      machine("b", 2, ["docker", "arm"]),
      machine("a", 1, ["docker"]),
      machine("c", 0, ["docker"]),
    ];
    const online = new Set(["a", "b"]);
    expect(pickMachine(machines, online, ["docker"])?.id).toBe("a");
    expect(pickMachine(machines, online, ["docker", "arm"])?.id).toBe("b");
    expect(pickMachine(machines, online, ["gpu"])).toBeNull();
  });

  it("checks commands and labels", () => {
    expect(parseCommand({ kind: "shell", script: "uptime" })).toEqual({ kind: "shell", script: "uptime" });
    expect(parseCommand({ kind: "shell", script: " " })).toMatch(/script/);
    expect(parseCommand({ kind: "format-disk" })).toMatch(/no command/);
    expect(parseLabels(["Docker", "docker", "arm"])).toEqual(["docker", "arm"]);
    expect(parseLabels(["no spaces"])).toMatch(/label/);
    expect(machineIdFor("Oracle VPS!")).toMatch(/^oracle-vps-[0-9a-f]{6}$/);
  });
});

describe("machine members (K-107)", () => {
  const m1 = machine("m1", 0, []);
  const machines = new Map([[m1.id, m1]]);
  const circle: Circle = {
    id: "agents",
    name: "Agents",
    color: "#6C5CE7",
    level: "use",
    members: [{ _tag: "machine", machineId: "m1" }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 0,
    y: 0,
    r: 100,
  };

  it("matches the machine's service token and compiles to it", () => {
    expect(circleMatches(circle, { email: null, clientId: "m1.access", ip: null }, machines)).toBe(true);
    expect(circleMatches(circle, { email: null, clientId: "other.access", ip: null }, machines)).toBe(false);
    expect(circlePolicies(circle, machines).get("policy:agents:tokens")?.include).toEqual([
      { service_token: { token_id: "token-m1" } },
    ]);
  });

  it("matches nobody and compiles to nothing for an unknown machine", () => {
    expect(circleMatches(circle, { email: null, clientId: "m1.access", ip: null }, new Map())).toBe(false);
    expect(circlePolicies({ ...circle, match: "all" }, new Map()).size).toBe(0);
  });
});
