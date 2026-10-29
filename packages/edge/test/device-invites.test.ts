import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { accessToken, send, stubAccessCerts } from "./access.ts";

/** K-1601: device invites, through the Worker, against a fake of the service token API of Cloudflare. */

afterEach(() => vi.restoreAllMocks());

type Api = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** The fake API in the Durable Object; `calls` names each call, `failRotate` refuses the next rotates. */
async function setup() {
  stubAccessCerts();
  const stub = env.KITSHN.getByName("kitshn");
  const fake = { calls: [] as Array<string>, failRotate: 0 };
  let rotations = 0;
  const api: Api = async (method, path, body) => {
    fake.calls.push(`${method} ${path}`);
    const tokens = "/accounts/acct/access/service_tokens";
    if (method === "POST" && path === tokens) {
      const name = (body as { name: string }).name;
      return { id: `t-${name}`, client_id: `${name}.access`, client_secret: "created-secret", name };
    }
    if (method === "GET" && path === `${tokens}/t-machine`)
      return { id: "t-machine", client_id: "vps.access", name: "kitshn vps" };
    if (method === "GET" && path === `${tokens}/t-old`)
      return { id: "t-old", client_id: "old.access", name: "kitshn device Old phone" };
    if (method === "POST" && path.endsWith("/rotate")) {
      if (fake.failRotate > 0) {
        fake.failRotate--;
        throw new Error("rotate refused");
      }
      rotations++;
      return { client_secret: `rotated-${rotations}` };
    }
    throw new Error(`Unexpected API call: ${method} ${path}`);
  };
  await runInDurableObject(stub, (instance, state) => {
    (instance as unknown as { api: () => Api }).api = () => api;
    (instance as unknown as { env: object }).env = { ...env, CLOUDFLARE_ACCOUNT_ID: "acct" };
    state.storage.sql.exec("DELETE FROM device_invites");
    state.storage.sql.exec("DELETE FROM meta WHERE key = 'paused'");
  });
  const sql = (query: string, ...values: Array<string | number>) =>
    runInDurableObject(stub, (_, state) => state.storage.sql.exec(query, ...values).toArray());
  return { fake, sql };
}

const asPerson = async (email: string, path: string, method: string, body?: object) =>
  send(path, {
    method,
    headers: {
      "cf-access-jwt-assertion": await accessToken("admin-aud", { email }),
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const invite = async (body: object) => {
  const response = await asPerson("owner@example.com", "/api/devices/invites", "POST", body);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, string> & { link: string },
  };
};

const codeOf = (link: string) => new URL(link).hash.slice("#code=".length);

const exchange = (code: string) =>
  send("/join/device", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, device: "Pixel 8 · Android 16" }),
  });

/** Every value in every table of the Durable Object, as one text. */
const everything = (sql: Awaited<ReturnType<typeof setup>>["sql"]) =>
  sql("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'").then(
    async (tables) =>
      JSON.stringify(await Promise.all(tables.map((table) => sql(`SELECT * FROM "${String(table.name)}"`)))),
  );

it("trades an invite once for a new secret, and keeps neither the code nor a secret", async () => {
  const { sql } = await setup();
  const made = await invite({ name: "Pixel" });
  expect(made.status).toBe(200);
  expect(made.body).toMatchObject({ name: "Pixel", clientId: "kitshn device Pixel.access" });
  expect(made.body.link).toMatch(/^https:\/\/kit\.example\.com\/join\/device#code=[0-9a-f]{32}$/);
  const code = codeOf(made.body.link);
  const used = await exchange(code);
  expect(used.status).toBe(200);
  expect(await used.json()).toEqual({
    clientId: "kitshn device Pixel.access",
    name: "Pixel",
    serviceToken: { clientId: "kitshn device Pixel.access", clientSecret: "rotated-1" },
    machines: [],
    machinesUrl: "https://kit.example.com/device/machines",
  });
  const stored = await everything(sql);
  for (const secret of [code, "created-secret", "rotated-1"]) expect(stored).not.toContain(secret);
  // Single use.
  expect((await exchange(code)).status).toBe(404);
});

it("refuses an expired invite and drops it", async () => {
  const { sql } = await setup();
  const code = codeOf((await invite({ name: "Late" })).body.link);
  await sql("UPDATE device_invites SET expires_at = ?", Date.now() - 1);
  expect((await exchange(code)).status).toBe(410);
  expect(await sql("SELECT * FROM device_invites")).toEqual([]);
});

it("cancels an invite without touching its token", async () => {
  const { fake } = await setup();
  const made = await invite({ name: "Gone" });
  fake.calls.length = 0;
  const cancelled = await asPerson(
    "owner@example.com",
    `/api/devices/invites/${encodeURIComponent(made.body.tokenId!)}`,
    "DELETE",
  );
  expect(cancelled.status).toBe(200);
  expect((await exchange(codeOf(made.body.link))).status).toBe(404);
  expect(fake.calls).toEqual([]);
});

it("lets only the owner make or cancel an invite", async () => {
  const { fake } = await setup();
  expect((await asPerson("guest@example.com", "/api/devices/invites", "POST", { name: "X" })).status).toBe(
    403,
  );
  expect((await asPerson("guest@example.com", "/api/devices/invites/t-x", "DELETE")).status).toBe(403);
  expect(fake.calls).toEqual([]);
});

it("invites an existing device token again, never a machine token, and the new invite ends the old", async () => {
  await setup();
  expect((await invite({ tokenId: "t-machine" })).status).toBe(400);
  const first = codeOf((await invite({ tokenId: "t-old" })).body.link);
  const second = await invite({ tokenId: "t-old" });
  expect(second.body).toMatchObject({ name: "Old phone", clientId: "old.access" });
  expect((await exchange(first)).status).toBe(404);
  expect((await exchange(codeOf(second.body.link))).status).toBe(200);
});

it("keeps the invite when the rotate fails or kitshn is paused", async () => {
  const { fake, sql } = await setup();
  const code = codeOf((await invite({ name: "Retry" })).body.link);
  fake.failRotate = 1;
  expect((await exchange(code)).status).toBe(502);
  await sql("INSERT OR REPLACE INTO meta (key, value) VALUES ('paused', 'keep-public')");
  await runInDurableObject(env.KITSHN.getByName("kitshn"), (instance) =>
    (instance as unknown as { load: () => void }).load(),
  );
  expect((await exchange(code)).status).toBe(423);
  await sql("DELETE FROM meta WHERE key = 'paused'");
  await runInDurableObject(env.KITSHN.getByName("kitshn"), (instance) =>
    (instance as unknown as { load: () => void }).load(),
  );
  expect((await exchange(code)).status).toBe(200);
});

it("refuses a code of the wrong shape in the Worker", async () => {
  await setup();
  expect((await exchange("not-a-code")).status).toBe(400);
});
