import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index.ts";

/** K-819: the repo list's GitHub check, through the Worker and the Durable Object. */

const TEAM = "https://team.example.com";
const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256" };

const ownerToken = () =>
  new SignJWT({ email: "owner@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(TEAM)
    .setAudience("admin-aud")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);

/** Access keys answer; GitHub lists one installation that holds all repos, and answers 403 for the repo. */
function stubGitHubForbidden() {
  const github: Array<string> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    if (!url.startsWith("https://api.github.com/")) throw new Error(`Unexpected fetch: ${url}`);
    github.push(url);
    const path = url.slice("https://api.github.com".length);
    if (path.startsWith("/app/installations?"))
      return Response.json([{ id: 6, account: { login: "owner" }, repository_selection: "all" }]);
    if (path === "/app/installations/6/access_tokens") return Response.json({ token: "t6" });
    return Response.json({ message: "Forbidden" }, { status: 403 });
  });
  return github;
}

async function check() {
  const request = new Request<unknown, IncomingRequestCfProperties>(
    "https://kit.example.com/api/repos/check",
    {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": await ownerToken(),
        origin: "https://kit.example.com",
        "content-type": "application/json",
      },
      body: "{}",
    },
  );
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const row = () =>
  runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, state) =>
    state.storage.sql
      .exec<{ checked_at: number | null; gone_at: number | null }>(
        "SELECT checked_at, gone_at FROM repos WHERE repo_id = '1002'",
      )
      .one(),
  );

afterEach(() => vi.restoreAllMocks());

describe("the GitHub check of the repo list (K-819)", () => {
  it("counts an unknown answer as the day's check, keeps the mark, and asks no more that day", async () => {
    await runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO repos (repo_id, name, state, first_seen, gone_at) VALUES ('1002', 'owner/deleted', 'waiting', 1, 5)`,
      );
    });
    const github = stubGitHubForbidden();
    expect((await check()).status).toBe(200);
    expect(github.some((url) => url.endsWith("/repositories/1002"))).toBe(true);
    const first = await row();
    expect(first.checked_at).not.toBeNull();
    expect(first.gone_at).toBe(5);

    const calls = github.length;
    expect((await check()).status).toBe(200);
    expect(github.length).toBe(calls);
    expect((await row()).checked_at).toBe(first.checked_at);
  });
});
