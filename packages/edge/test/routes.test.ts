import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Edit } from "../src/core/changes.ts";
import type { Circle } from "../src/core/model.ts";
import worker from "../src/worker/index.ts";

const TEAM = "https://team.example.com";
const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256" };

/** A second key pair that the team does not publish. */
const strangerKeys = await generateKeyPair("RS256");

/**
 * An Access token signed by the test team key, as Access sends it in `Cf-Access-Jwt-Assertion`. `changes` makes a
 * token that the Worker must refuse.
 */
const accessToken = (
  audience: string,
  claims: { email: string } | { common_name: string },
  changes: { key?: CryptoKey; issuer?: string; expiresAt?: number } = {},
) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(changes.issuer ?? TEAM)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(changes.expiresAt ?? "5m")
    .sign(changes.key ?? keys.privateKey);

/** The Worker fetches only the team keys; any other outbound request fails the test. */
function stubAccessCerts() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

async function call(path: string, token: string | null, body?: object) {
  const headers = new Headers(token ? { "cf-access-jwt-assertion": token } : {});
  if (body) headers.set("content-type", "application/json");
  const request = new Request<unknown, IncomingRequestCfProperties>(`https://kit.example.com${path}`, {
    method: body ? "POST" : "GET",
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

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
