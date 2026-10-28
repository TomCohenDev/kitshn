import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index.ts";

/** K-806: Worker deploys through the deploy steps of the Worker and its Durable Object. */

const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "gh", alg: "RS256" };
const API = "https://api.cloudflare.com/client/v4";

/**
 * A fake of the Cloudflare API with state. Like Cloudflare, it refuses a `new_sqlite_classes` migration for a class
 * that the script already has, and it reconciles `exports`. `failDomains` fails the next custom domain calls.
 */
function fakeCloudflare() {
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const scripts = new Map<string, { classes: Set<string> }>();
  const domains: Array<{ id: string; hostname: string; service: string }> = [];
  const uploads: Array<Record<string, unknown>> = [];
  const state = { failDomains: 0 };
  let next = 1;
  const collection = (path: string) => {
    const found = collections.get(path) ?? new Map<string, Record<string, unknown>>();
    collections.set(path, found);
    return found;
  };
  collection("/accounts/acct/access/apps").set("launcher", {
    id: "launcher",
    type: "app_launcher",
    policies: [],
  });
  const ok = (result: unknown) => Response.json({ success: true, result });
  const refuse = (message: string) =>
    Response.json({ success: false, errors: [{ code: 10000, message }] }, { status: 400 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);
    if (request.url === "https://token.actions.githubusercontent.com/.well-known/jwks")
      return Response.json({ keys: [jwk] });
    if (!request.url.startsWith(API)) return new Response(null, { status: 302 });
    const path = url.pathname.slice("/client/v4".length);
    const method = request.method;
    const script = /^\/accounts\/acct\/workers\/scripts\/([^/]+)$/.exec(path)?.[1];
    if (script && method === "PUT") {
      const form = await request.formData();
      const metadata = JSON.parse(await (form.get("metadata") as Blob).text()) as Record<string, unknown>;
      uploads.push(metadata);
      const known = scripts.get(script)?.classes ?? new Set<string>();
      const migration = metadata["migrations"] as { new_sqlite_classes?: Array<string> } | undefined;
      const added = migration?.new_sqlite_classes?.find((name) => known.has(name));
      if (added)
        return refuse(
          `Cannot apply new-sqlite-class migration to class '${added}' that is already depended on`,
        );
      const declared = Object.keys((metadata["exports"] as Record<string, unknown> | undefined) ?? {});
      const dropped = [...known].find((name) => !declared.includes(name) && !migration);
      if (dropped) return refuse(`The class ${dropped} has a namespace but no exports entry`);
      scripts.set(script, {
        classes: new Set([...known, ...declared, ...(migration?.new_sqlite_classes ?? [])]),
      });
      return ok({ id: script });
    }
    if (path === "/accounts/acct/workers/scripts" && method === "GET")
      return ok([...scripts.keys()].map((id) => ({ id, handlers: ["fetch"] })));
    if (path.startsWith("/accounts/acct/workers/scripts/")) return ok({ schedules: [] });
    if (path === "/accounts/acct/workers/domains") {
      if (method === "GET")
        return ok(domains.filter((item) => item.hostname === url.searchParams.get("hostname")));
      if (state.failDomains > 0) {
        state.failDomains--;
        return refuse("the custom domain failed");
      }
      const body = (await request.json()) as { hostname: string; service: string };
      domains.push({ id: `d${next++}`, hostname: body.hostname, service: body.service });
      return ok({});
    }
    // Every other call: a collection of objects with ids, such as Access applications, policies and KV namespaces.
    const parts = path.split("/");
    const last = parts.at(-1) ?? "";
    const items = collection(path);
    if (method === "GET" && collections.has(path)) return ok([...items.values()]);
    const parent = collection(parts.slice(0, -1).join("/"));
    if (method === "GET") return ok(parent.get(last) ?? []);
    if (method === "POST" && !parent.has(last)) {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const id = `id${next++}`;
      const item = { ...body, id, aud: `aud-${id}` };
      items.set(id, item);
      return ok(item);
    }
    if (method === "PUT") {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      parent.set(last, { ...parent.get(last), ...body, id: last });
      return ok(parent.get(last));
    }
    if (method === "DELETE") parent.delete(last);
    return ok({});
  });
  return { uploads, state };
}

const token = () =>
  new SignJWT({
    repository: "owner/rooms",
    repository_id: "42",
    repository_owner_id: "1",
    sha: "0123456789abcdef",
    event_name: "push",
    ref: "refs/heads/main",
  })
    .setProtectedHeader({ alg: "RS256", kid: "gh" })
    .setIssuer("https://token.actions.githubusercontent.com")
    .setAudience("https://kit.example.com")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);

async function step(path: string, body: unknown) {
  const request = new Request<unknown, IncomingRequestCfProperties>(`https://kit.example.com${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const recipe = {
  worker: { main: "worker.js", compatibilityDate: "2026-10-01", durableObjects: { ROOMS: "Room" } },
  deploy: [{ on: "push", branch: "main", name: "prod", startsIn: "Everyone" }],
};

/** One deploy from the plan to the finish. The Access sync has a budget per step, so a 503 finish runs again. */
async function deploy() {
  const plan = await step("/deploy/plan", { recipe, event: {} });
  const deployId = plan.body["deployId"];
  expect(deployId, JSON.stringify(plan.body)).toEqual(expect.any(String));
  expect((await step("/deploy/storage", { deployId })).status).toBe(200);
  for (let attempt = 0; attempt < 10; attempt++) {
    const finish = await step("/deploy/finish", {
      deployId,
      module: "export class Room {} export default {};",
    });
    if (finish.status !== 503) return finish;
  }
  throw new Error("The Access applications never became ready.");
}

afterEach(() => vi.restoreAllMocks());

describe("Worker deploys (K-806)", () => {
  it("deploys again after a step that failed after the upload", async () => {
    const cloudflare = fakeCloudflare();
    await runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, durable) => {
      durable.storage.sql.exec(
        "INSERT INTO repos (repo_id, name, state, first_seen) VALUES ('42', 'owner/rooms', 'allowed', 0)",
      );
    });
    cloudflare.state.failDomains = 1;
    const first = await deploy();
    expect(first.status).toBe(502);
    expect(cloudflare.uploads).toHaveLength(1);
    const second = await deploy();
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(cloudflare.uploads).toHaveLength(2);
    expect(cloudflare.uploads[1]?.["exports"]).toEqual({
      Room: { type: "durable-object", storage: "sqlite" },
    });
    expect(cloudflare.uploads[1]).not.toHaveProperty("migrations");
  });
});
