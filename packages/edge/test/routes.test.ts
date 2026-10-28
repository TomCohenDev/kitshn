import { afterEach, describe, expect, it, vi } from "vitest";
import type { Edit } from "../src/core/changes.ts";
import type { Circle } from "../src/core/model.ts";
import { accessToken, send, strangerKeys, stubAccessCerts } from "./access.ts";

const call = (path: string, token: string | null, body?: object) => {
  const headers = new Headers(token ? { "cf-access-jwt-assertion": token } : {});
  if (body) headers.set("content-type", "application/json");
  return send(path, {
    method: body ? "POST" : "GET",
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
};

afterEach(() => vi.restoreAllMocks());

describe("owner route /api/state", () => {
  it("answers the owner with the map", async () => {
    stubAccessCerts();
    const response = await call("/api/state", await accessToken("admin-aud", { email: "owner@example.com" }));
    expect(response.status).toBe(200);
    const state = (await response.json()) as { circles: ReadonlyArray<{ name: string }> };
    expect(state.circles.map((circle) => circle.name)).toContain("Owner");
  });

  it("refuses a person outside the Owner circle", async () => {
    stubAccessCerts();
    const response = await call("/api/state", await accessToken("admin-aud", { email: "guest@example.com" }));
    expect(response.status).toBe(403);
  });

  it("refuses a token of another Access application", async () => {
    stubAccessCerts();
    const response = await call("/api/state", await accessToken("agent-aud", { email: "owner@example.com" }));
    expect(response.status).toBe(401);
  });

  it("refuses a token signed by another key with the same key id", async () => {
    stubAccessCerts();
    const token = await accessToken(
      "admin-aud",
      { email: "owner@example.com" },
      { key: strangerKeys.privateKey },
    );
    expect((await call("/api/state", token)).status).toBe(401);
  });

  it("refuses an expired token", async () => {
    stubAccessCerts();
    // Older than the 60 seconds of clock tolerance.
    const expiresAt = Math.floor(Date.now() / 1000) - 120;
    const token = await accessToken("admin-aud", { email: "owner@example.com" }, { expiresAt });
    expect((await call("/api/state", token)).status).toBe(401);
  });

  it("refuses a token of another issuer", async () => {
    stubAccessCerts();
    const token = await accessToken(
      "admin-aud",
      { email: "owner@example.com" },
      { issuer: "https://other.example.com" },
    );
    expect((await call("/api/state", token)).status).toBe(401);
  });

  it("refuses a request without an Access token", async () => {
    expect((await call("/api/state", null)).status).toBe(401);
  });

  it("refuses a stack name with spaces around it, so no stack shows a blank name (K-521)", async () => {
    stubAccessCerts();
    const owner = await accessToken("admin-aud", { email: "owner@example.com" });
    const stack = (name: string): ReadonlyArray<Edit> => [
      { _tag: "stack", id: "s-blank", after: { id: "s-blank", name, members: [] } },
    ];
    expect((await call("/api/apply", owner, { edits: stack("   ") })).status).toBe(400);
    expect((await call("/api/apply", owner, { edits: stack(" Sites") })).status).toBe(400);
  });
});

describe("agent route /agent/state (K-718)", () => {
  it("answers a service token that the owner put in an agent circle", async () => {
    stubAccessCerts();
    const owner = await accessToken("admin-aud", { email: "owner@example.com" });
    const agents: Circle = {
      id: "agents",
      name: "Agents",
      color: "#7c3aed",
      level: "control",
      members: [{ _tag: "device", tokenId: "t1", clientId: "agent-1.access", name: "Agent" }],
      match: "any",
      needsPasskey: false,
      endsAt: null,
      x: 2000,
      y: 2000,
      r: 200,
    };
    const edits: ReadonlyArray<Edit> = [{ _tag: "circle", id: agents.id, after: agents }];
    expect((await call("/api/apply", owner, { edits })).status).toBe(200);
    const response = await call(
      "/agent/state",
      await accessToken("agent-aud", { common_name: "agent-1.access" }),
    );
    expect(response.status).toBe(200);
    const state = (await response.json()) as { circles: ReadonlyArray<{ id: string }> };
    expect(state.circles.map((circle) => circle.id)).toEqual(["agents"]);
  });

  it("refuses a person's token", async () => {
    stubAccessCerts();
    const response = await call(
      "/agent/state",
      await accessToken("agent-aud", { email: "owner@example.com" }),
    );
    expect(response.status).toBe(403);
  });

  it("refuses a service token in no agent circle", async () => {
    stubAccessCerts();
    const response = await call(
      "/agent/state",
      await accessToken("agent-aud", { common_name: "stranger.access" }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: expect.stringContaining("no agent circle") });
  });
});
