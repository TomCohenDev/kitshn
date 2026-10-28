import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { Machine } from "../src/core/machine.ts";
import type { Circle, RightMode } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

afterEach(() => vi.restoreAllMocks());

/** The machine vps in the agent circle "agents" with these rights. */
async function setup(rights: Partial<Record<string, RightMode>>) {
  const machine: Machine = {
    id: "vps",
    name: "vps",
    labels: [],
    order: 0,
    serviceTokenId: "token-vps",
    clientId: "vps.access",
    tunnelId: "tunnel-vps",
  };
  const agents: Circle = {
    id: "agents",
    name: "Agents",
    color: "#ffcc00",
    level: "control",
    members: [{ _tag: "machine", machineId: "vps", rights }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 5000,
    y: 5000,
    r: 200,
  };
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO machines (id, body) VALUES (?, ?)",
      "vps",
      JSON.stringify(machine),
    );
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO circles (id, body) VALUES (?, ?)",
      "agents",
      JSON.stringify(agents),
    );
  });
  await evictDurableObject(stub);
}

it("refuses the machine's own token on every agent path over HTTP, so asks always go through kitshn agent (K-1714)", async () => {
  stubAccessCerts();
  await setup({ runsCommands: { mode: "automatic" }, deploys: { mode: "automatic" } });
  const token = await accessToken("agent-aud", { common_name: "vps.access" });
  const headers = { "cf-access-jwt-assertion": token, "content-type": "application/json" };
  for (const [method, path] of [
    ["GET", "/agent/state"],
    ["POST", "/agent/apply"],
    ["POST", "/agent/jobs"],
    ["GET", "/agent/jobs/1"],
    ["POST", "/agent/deploy"],
    ["POST", "/agent/repos/123"],
    ["POST", "/agent/library"],
  ] as const) {
    const response = await send(path, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) });
    expect(response.status, path).toBe(403);
  }
});
