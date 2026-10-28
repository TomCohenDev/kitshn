import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { environmentNames } from "../src/worker/deploys.ts";
import worker from "../src/worker/index.ts";

/** K-806, K-909: Worker deploys, their removal and their storage, through the Worker and its Durable Object. */

const github = await generateKeyPair("RS256");
const team = await generateKeyPair("RS256");
const githubJwk = { ...(await exportJWK(github.publicKey)), kid: "gh", alg: "RS256" };
const teamJwk = { ...(await exportJWK(team.publicKey)), kid: "team", alg: "RS256" };
const API = "https://api.cloudflare.com/client/v4";

/**
 * A fake of the Cloudflare API with state. Like Cloudflare, it refuses a `new_sqlite_classes` migration for a class
 * that the script already has, and a script whose `exports` drop a class. `failDomains` fails the next custom domain
 * calls, `onDelete` runs before a script or KV delete answers, and `others` are scripts with crons of someone else.
 */
function fakeCloudflare(others: Record<string, number> = {}) {
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const scripts = new Map<string, { classes: Set<string>; crons: Array<string> }>();
  for (const [id, count] of Object.entries(others))
    scripts.set(id, { classes: new Set(), crons: Array.from({ length: count }, () => "0 * * * *") });
  const domains: Array<{ id: string; hostname: string; service: string }> = [];
  const uploads: Array<Record<string, unknown>> = [];
  /** K-821: each rollback of a script to a version, in order. */
  const rollbacks: Array<{ script: string; version: string }> = [];
  const state: {
    failDomains: number;
    failUploads: number;
    refuseRollbacks: Array<string>;
    onDelete: (() => Promise<void>) | null;
  } = {
    failDomains: 0,
    failUploads: 0,
    refuseRollbacks: [],
    onDelete: null,
  };
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
      return Response.json({ keys: [githubJwk] });
    if (request.url === "https://team.example.com/cdn-cgi/access/certs")
      return Response.json({ keys: [teamJwk] });
    if (!request.url.startsWith(API)) return new Response(null, { status: 302 });
    const path = url.pathname.slice("/client/v4".length);
    const method = request.method;
    const script = /^\/accounts\/acct\/workers\/scripts\/([^/]+)$/.exec(path)?.[1];
    if (script && method === "PUT") {
      const form = await request.formData();
      const metadata = JSON.parse(await (form.get("metadata") as Blob).text()) as Record<string, unknown>;
      uploads.push(metadata);
      if (state.failUploads > 0) {
        state.failUploads--;
        return refuse("the upload failed");
      }
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
        crons: scripts.get(script)?.crons ?? [],
      });
      return ok({ id: script });
    }
    if (script && method === "DELETE") {
      await state.onDelete?.();
      scripts.delete(script);
      return ok({});
    }
    if (path === "/accounts/acct/workers/scripts" && method === "GET")
      return ok(
        [...scripts].map(([id, item]) => ({
          id,
          handlers: item.crons.length > 0 ? ["fetch", "scheduled"] : ["fetch"],
        })),
      );
    const schedules = /^\/accounts\/acct\/workers\/scripts\/([^/]+)\/schedules$/.exec(path)?.[1];
    if (schedules) {
      const item = scripts.get(schedules);
      if (!item)
        return Response.json(
          { success: false, errors: [{ code: 10007, message: "no such script" }] },
          { status: 404 },
        );
      if (method === "PUT")
        item.crons = ((await request.json()) as Array<{ cron: string }>).map((entry) => entry.cron);
      return ok({ schedules: item.crons.map((cron) => ({ cron })) });
    }
    const deployed = /^\/accounts\/acct\/workers\/scripts\/([^/]+)\/deployments$/.exec(path)?.[1];
    if (deployed && method === "POST") {
      const body = (await request.json()) as { versions: Array<{ version_id: string }> };
      if (state.refuseRollbacks.includes(deployed))
        return refuse("a Durable Object class changed since that version");
      rollbacks.push({ script: deployed, version: body.versions[0]?.version_id ?? "" });
      return ok({});
    }
    if (deployed) return ok({ deployments: [{ versions: [{ version_id: `version-${uploads.length}` }] }] });
    if (path.startsWith("/accounts/acct/workers/scripts/")) return ok({});
    if (path === "/accounts/acct/workers/domains") {
      if (method === "GET")
        return ok(
          domains.filter(
            (item) =>
              item.hostname === url.searchParams.get("hostname") ||
              item.service === url.searchParams.get("service"),
          ),
        );
      if (state.failDomains > 0) {
        state.failDomains--;
        return refuse("the custom domain failed");
      }
      const body = (await request.json()) as { hostname: string; service: string };
      domains.push({ id: `d${next++}`, hostname: body.hostname, service: body.service });
      return ok({});
    }
    if (path.startsWith("/accounts/acct/workers/domains/") && method === "DELETE") {
      const index = domains.findIndex((item) => item.id === path.split("/").at(-1));
      if (index >= 0) domains.splice(index, 1);
      return ok({});
    }
    if (path.startsWith("/accounts/acct/storage/kv/namespaces/") && method === "DELETE")
      await state.onDelete?.();
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
  const served = (hostname: string) =>
    domains.filter((item) => item.hostname === hostname).map((item) => item.service);
  /** Deletes a KV namespace behind kitshn's back, as a restart in the middle of an orphan delete can leave it. */
  const dropKv = (id: string) => collection("/accounts/acct/storage/kv/namespaces").delete(id);
  return { uploads, state, scripts, served, dropKv, rollbacks };
}

/** One repo of the test, so each test has its own cards. */
function repo(id: string, name: string) {
  const card = environmentNames(id, `owner/${name}`, "prod").resourceId;
  /** The workflow run and the commit that the next token names. */
  const run = { id: "100", sha: "0123456789abcdef" };
  const token = () =>
    new SignJWT({
      repository: `owner/${name}`,
      repository_id: id,
      repository_owner_id: "1",
      sha: run.sha,
      run_id: run.id,
      run_attempt: "1",
      event_name: "push",
      ref: "refs/heads/main",
    })
      .setProtectedHeader({ alg: "RS256", kid: "gh" })
      .setIssuer("https://token.actions.githubusercontent.com")
      .setAudience("https://kit.example.com")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(github.privateKey);
  return { id, name, card, script: `kitshn-${card}`, address: `${name}.example.com`, token, run };
}

async function call(path: string, method: string, headers: Record<string, string>, body?: unknown) {
  const request = new Request<unknown, IncomingRequestCfProperties>(`https://kit.example.com${path}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const step = async (app: ReturnType<typeof repo>, path: string, body: unknown) =>
  call(path, "POST", { authorization: `Bearer ${await app.token()}` }, body);

/** A request of the owner to the admin API, with an Access token. */
const admin = async (path: string, method: string, body?: unknown) =>
  call(
    path,
    method,
    {
      "cf-access-jwt-assertion": await new SignJWT({ email: "owner@example.com" })
        .setProtectedHeader({ alg: "RS256", kid: "team" })
        .setIssuer("https://team.example.com")
        .setAudience("admin-aud")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(team.privateKey),
      origin: "https://kit.example.com",
    },
    body,
  );

const recipe = (worker: Record<string, unknown> = {}, name = "prod", needs?: ReadonlyArray<string>) => ({
  ...(needs ? { needs: { apps: needs } } : {}),
  worker: {
    main: "worker.js",
    compatibilityDate: "2026-10-01",
    durableObjects: { ROOMS: "Room" },
    ...worker,
  },
  deploy: [{ on: "push", branch: "main", name, startsIn: "Everyone" }],
});

async function allow(app: ReturnType<typeof repo>) {
  await runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, durable) => {
    durable.storage.sql.exec(
      "INSERT INTO repos (repo_id, name, state, first_seen) VALUES (?, ?, 'allowed', 0)",
      app.id,
      `owner/${app.name}`,
    );
  });
}

/** One deploy from the plan to the finish. The Access sync has a budget per step, so a 503 finish runs again. */
async function deploy(
  app: ReturnType<typeof repo>,
  worker: Record<string, unknown> = {},
  key?: string,
  needs?: ReadonlyArray<string>,
) {
  const plan = await step(app, "/deploy/plan", {
    recipe: recipe(worker, "prod", needs),
    event: {},
    ...(key ? { key } : {}),
  });
  const deployId = plan.body["deployId"];
  expect(deployId, JSON.stringify(plan.body)).toEqual(expect.any(String));
  const storage = await step(app, "/deploy/storage", { deployId });
  if (storage.status !== 200) return storage;
  for (let attempt = 0; attempt < 10; attempt++) {
    const finish = await step(app, "/deploy/finish", {
      deployId,
      module: "export class Room {} export default {};",
    });
    if (finish.status !== 503) return finish;
  }
  throw new Error("The Access applications never became ready.");
}

const storageRows = (card: string) =>
  runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, durable) =>
    durable.storage.sql
      .exec("SELECT kind, name FROM worker_storage WHERE card_id = ? ORDER BY kind", card)
      .toArray(),
  );

afterEach(() => vi.restoreAllMocks());

describe("Worker deploys (K-806, K-909)", () => {
  it("deploys again after a step that failed after the upload", async () => {
    const cloudflare = fakeCloudflare();
    const app = repo("42", "rooms");
    await allow(app);
    cloudflare.state.failDomains = 1;
    expect((await deploy(app)).status).toBe(502);
    expect(cloudflare.uploads).toHaveLength(1);
    const second = await deploy(app);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(cloudflare.uploads[1]?.["exports"]).toEqual({
      Room: { type: "durable-object", storage: "sqlite" },
    });
    expect(cloudflare.uploads[1]).not.toHaveProperty("migrations");
  });

  it("turns the crons off on Remove app, keeps the script, and Undo brings addresses and crons back", async () => {
    const cloudflare = fakeCloudflare();
    const app = repo("43", "clock");
    await allow(app);
    expect((await deploy(app, { crons: ["*/30 * * * *"], kv: ["DATA"] })).status).toBe(200);
    expect(cloudflare.served(app.address)).toEqual([app.script]);
    const removed = await admin(`/api/apps/${app.card}`, "DELETE");
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(cloudflare.served(app.address)).toEqual([]);
    expect(cloudflare.scripts.get(app.script)?.crons).toEqual([]);
    const undone = await admin("/api/undo", "POST", { revision: removed.body["revision"] });
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    expect(cloudflare.served(app.address)).toEqual([app.script]);
    expect(cloudflare.scripts.get(app.script)?.crons).toEqual(["*/30 * * * *"]);
  });

  it("removes an app whose first upload failed, so it has no script", async () => {
    const cloudflare = fakeCloudflare();
    const app = repo("46", "broken");
    await allow(app);
    cloudflare.state.failUploads = 1;
    expect((await deploy(app)).status).toBe(502);
    expect(cloudflare.scripts.has(app.script)).toBe(false);
    const removed = await admin(`/api/apps/${app.card}`, "DELETE");
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(await storageRows(app.card)).toEqual([]);
  });

  it("makes a KV namespace again when its row points to one that is gone", async () => {
    const cloudflare = fakeCloudflare();
    const app = repo("47", "notes");
    await allow(app);
    expect((await deploy(app, { kv: ["DATA"] })).status).toBe(200);
    const bound = (index: number) => {
      const bindings = cloudflare.uploads[index]?.["bindings"] as Array<Record<string, string>> | undefined;
      if (!bindings) throw new Error(`There is no upload ${index}.`);
      return bindings.find((item) => item["name"] === "DATA")?.["namespace_id"];
    };
    const first = bound(0);
    cloudflare.dropKv(first ?? "");
    expect((await deploy(app, { kv: ["DATA"] })).status).toBe(200);
    expect(bound(1)).toEqual(expect.any(String));
    expect(bound(1)).not.toBe(first);
  });

  it("deletes orphaned storage only while no deploy runs, and refuses a deploy that starts during the delete", async () => {
    const cloudflare = fakeCloudflare();
    const app = repo("44", "vault");
    await allow(app);
    expect((await deploy(app, { kv: ["DATA"] })).status).toBe(200);
    expect((await admin(`/api/apps/${app.card}`, "DELETE")).status).toBe(200);
    // A deploy that is planned and not finished keeps the storage.
    const planned = await step(app, "/deploy/plan", { recipe: recipe({ kv: ["DATA"] }), event: {} });
    expect((await admin(`/api/worker-storage/${app.card}`, "DELETE")).status).toBe(409);
    await runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, durable) => {
      durable.storage.sql.exec("UPDATE deploys SET expires_at = 0 WHERE id = ?", planned.body["deployId"]);
    });
    const during: Array<number> = [];
    cloudflare.state.onDelete = async () => {
      during.push((await step(app, "/deploy/plan", { recipe: recipe({ kv: ["DATA"] }), event: {} })).status);
    };
    const deleted = await admin(`/api/worker-storage/${app.card}`, "DELETE");
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body["deleted"]).toEqual([
      `the Worker ${app.script} with its Durable Objects`,
      "the KV DATA",
    ]);
    expect(during).toEqual([409, 409]);
    expect(await storageRows(app.card)).toEqual([]);
    expect(cloudflare.scripts.has(app.script)).toBe(false);
  });

  it("refuses crons that would take the account over 5 before the upload", async () => {
    const cloudflare = fakeCloudflare({ "someone-else": 4 });
    const app = repo("45", "ticker");
    await allow(app);
    const refused = await deploy(app, { crons: ["0 * * * *", "30 * * * *"] });
    expect(refused.status).toBe(409);
    expect(String(refused.body["error"])).toMatch(/run 4 crons/);
    expect(cloudflare.uploads).toHaveLength(0);
    expect((await deploy(app, { crons: ["0 * * * *"] })).status).toBe(200);
  });
});

describe("several apps per repo (K-804, K-820)", () => {
  const plan = (app: ReturnType<typeof repo>, body: Record<string, unknown>) =>
    step(app, "/deploy/plan", { recipe: recipe(), event: {}, ...body });
  const state = async () =>
    (await admin("/api/state", "GET")).body as {
      resources: Array<{ id: string; name: string }>;
      deployNotes: Record<string, { state: string; reason: string }>;
    };

  it("refuses a card of another app of the repo, and a key that is not a plain name", async () => {
    fakeCloudflare();
    const app = repo("50", "multi");
    await allow(app);
    // The app `app` with the environment cv-prod and the app `cv` with prod make the same card id.
    expect((await step(app, "/deploy/plan", { recipe: recipe({}, "cv-prod"), event: {} })).status).toBe(200);
    const clash = await plan(app, { key: "cv" });
    expect(clash.status).toBe(409);
    expect(String(clash.body["error"])).toMatch(/belongs to another app \(app\)/);
    expect((await plan(app, { key: "Bad-Key" })).status).toBe(400);
  });

  it("names the card with its key, and shows a skipped and a failed deploy on it", async () => {
    fakeCloudflare();
    const app = repo("51", "shop");
    await allow(app);
    expect((await deploy(app, {}, "cv")).status).toBe(200);
    const card = environmentNames(app.id, `owner/${app.name}`, "prod", "cv").resourceId;
    expect((await state()).resources.find((item) => item.id === card)?.name).toBe("shop-cv");
    const skipped = await plan(app, {
      key: "cv",
      skip: "not deployed, because it needs api, which did not deploy (K-820).",
    });
    expect(skipped.body["plan"]).toMatchObject({ kind: "skip" });
    expect((await state()).deployNotes[card]).toEqual({
      state: "skipped",
      reason: "not deployed, because it needs api, which did not deploy (K-820).",
    });
    const planned = await plan(app, { key: "cv" });
    expect(
      (await step(app, "/deploy/fail", { deployId: planned.body["deployId"], reason: "the build failed." }))
        .status,
    ).toBe(200);
    expect((await state()).deployNotes[card]).toEqual({ state: "failed", reason: "the build failed." });
  });

  it("keeps a running deploy running when the CLI gives up, so its machine result still lands", async () => {
    fakeCloudflare();
    const app = repo("52", "slow");
    await allow(app);
    const planned = await plan(app, {});
    const deployId = String(planned.body["deployId"]);
    await runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, durable) => {
      durable.storage.sql.exec(
        "UPDATE deploys SET state = 'running', app = 'compose' WHERE id = ?",
        deployId,
      );
    });
    expect(
      (await step(app, "/deploy/fail", { deployId, reason: "the deploy did not end within 38 minutes." }))
        .status,
    ).toBe(200);
    const row = await runInDurableObject(env.KITSHN.getByName("kitshn"), (_instance, durable) =>
      durable.storage.sql.exec("SELECT state, reason FROM deploys WHERE id = ?", deployId).one(),
    );
    expect(row).toEqual({ state: "running", reason: "the deploy did not end within 38 minutes." });
  });
});

describe("rollback (K-821)", () => {
  type Choice = { deployId: string; sha: string; why: string | null };
  const choices = async (card: string) =>
    ((await admin(`/api/apps/${card}/rollbacks`, "GET")).body["choices"] ?? []) as Array<Choice>;

  it("serves an earlier Cloudflare version again, and the card then counts it as its current deploy", async () => {
    const cloudflare = fakeCloudflare();
    const app = repo("60", "board");
    await allow(app);
    app.run.sha = "1111111aaaaaaa";
    expect((await deploy(app)).status).toBe(200);
    app.run.sha = "2222222bbbbbbb";
    app.run.id = "101";
    expect((await deploy(app)).status).toBe(200);
    const [current, before] = await choices(app.card);
    expect(current?.sha).toBe("2222222bbbbbbb");
    expect(before).toMatchObject({ sha: "1111111aaaaaaa", why: null });
    const rolled = await admin(`/api/apps/${app.card}/rollback`, "POST", { deployId: before?.deployId });
    expect(rolled.status, JSON.stringify(rolled.body)).toBe(200);
    expect(String(rolled.body["note"])).toMatch(/data did not roll back/);
    expect(cloudflare.rollbacks).toEqual([{ script: app.script, version: "version-1" }]);
    expect((await choices(app.card))[0]?.sha).toBe("1111111aaaaaaa");
  });

  it("shows the refusal of Cloudflare and changes nothing", async () => {
    const cloudflare = fakeCloudflare();
    const app = repo("61", "rooms2");
    await allow(app);
    expect((await deploy(app)).status).toBe(200);
    app.run.id = "101";
    expect((await deploy(app)).status).toBe(200);
    cloudflare.state.refuseRollbacks = [app.script];
    const before = (await choices(app.card))[1];
    const refused = await admin(`/api/apps/${app.card}/rollback`, "POST", { deployId: before?.deployId });
    expect(refused.status).toBe(409);
    expect(String(refused.body["error"])).toMatch(/Durable Object class changed/);
    expect((await choices(app.card))[0]?.deployId).not.toBe(before?.deployId);
  });

  it("rolls a run back app by app, each before the apps that it needs, and stops at the first refusal", async () => {
    const cloudflare = fakeCloudflare();
    const app = repo("62", "pair");
    const cv = { ...app, card: environmentNames("62", "owner/pair", "prod", "cv").resourceId };
    await allow(app);
    for (const run of ["100", "101"]) {
      app.run.id = run;
      expect((await deploy(app, {}, "app")).status).toBe(200);
      expect((await deploy(app, {}, "cv", ["app"])).status).toBe(200);
    }
    const plan = await admin(`/api/apps/${app.card}/run-rollback`, "GET");
    expect((plan.body["steps"] as Array<{ card: string }>).map((step) => step.card)).toEqual([
      cv.card,
      app.card,
    ]);
    cloudflare.state.refuseRollbacks = [`kitshn-${app.card}`];
    const result = await admin(`/api/apps/${app.card}/run-rollback`, "POST");
    expect(result.body["state"]).toBe("failed");
    expect(cloudflare.rollbacks.map((item) => item.script)).toEqual([`kitshn-${cv.card}`]);
    expect((result.body["notes"] as Array<string>).at(-1)).toMatch(/stopped here/);
  });
});
