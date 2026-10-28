import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Circle, Resource } from "../src/core/model.ts";
import { send } from "./access.ts";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]);

/** Cards in and around the Everyone circle; `change` edits that circle, `paused` sets the pause (K-1504). */
async function setup(change: Partial<Circle> = {}, paused: string | null = null) {
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (_, state) => {
    const sql = state.storage.sql;
    const [row] = sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = 'everyone'").toArray();
    const everyone: Circle = { ...(JSON.parse(row!.body) as Circle), endsAt: null, ...change };
    sql.exec("UPDATE circles SET body = ? WHERE id = 'everyone'", JSON.stringify(everyone));
    // The tests share one database, so each setup writes every row again.
    sql.exec("DELETE FROM meta WHERE key = 'paused'");
    if (paused) sql.exec("INSERT INTO meta (key, value) VALUES ('paused', ?)", paused);
    // "everyone" in an "all must match" circle with an IP range is not public.
    const office: Circle = {
      ...everyone,
      id: "office",
      name: "Office",
      match: "all",
      endsAt: null,
      members: [{ _tag: "everyone" }, { _tag: "ip", range: "10.0.0.0/8" }],
      x: everyone.x + 10_000,
    };
    sql.exec("INSERT OR REPLACE INTO circles (id, body) VALUES (?, ?)", office.id, JSON.stringify(office));
    const card = (
      id: string,
      kind: Resource["kind"],
      circle: Circle,
      environment: string | null,
      status: Resource["status"] = "running",
    ) => {
      const resource: Resource = {
        id,
        kind,
        name: id,
        addresses: [`${id}.example.com`, `${id}.example.org`],
        status,
        group: null,
        machine: null,
      };
      sql.exec("INSERT OR REPLACE INTO resources (id, body) VALUES (?, ?)", id, JSON.stringify(resource));
      sql.exec("INSERT OR REPLACE INTO places (id, x, y) VALUES (?, ?, ?)", id, circle.x, circle.y);
      if (environment === null) return;
      sql.exec(
        `INSERT OR REPLACE INTO deploys (id, repo, environment, resource_id, address, script, kind, sha, state, expires_at)
         VALUES (?, 'o/r', ?, ?, '', '', 'deploy', 'abc', 'done', 0)`,
        `deploy-${id}`,
        environment,
        id,
      );
    };
    card("tick3d", "site.static", everyone, "prod");
    card("brew", "site.compose", everyone, "prod");
    card("down-app", "site.compose", everyone, "prod", "offline");
    card("riffle-pr-4", "site.static", everyone, "pr-4");
    card("never-deployed", "site.worker", everyone, null);
    card("notes", "page", everyone, "prod");
    card("office-app", "site.static", office, "prod");
    card("private-app", "site.static", { ...everyone, x: everyone.x + 50_000 }, "prod");
    sql.exec(
      "INSERT OR REPLACE INTO icons (id, type, hash, bytes) VALUES ('tick3d', 'image/png', 'h', ?)",
      png,
    );
  });
  // The Durable Object reads the state again when it starts.
  await evictDurableObject(stub);
  return stub;
}

/** The Durable Object's answer, past the Worker's cache, which the route test fills. */
const listed = async (stub: DurableObjectStub) =>
  (
    (await (await stub.fetch("https://kitshn.internal/internal/public-cards")).json()) as {
      cards: ReadonlyArray<{ name: string }>;
    }
  ).cards.map((card) => card.name);

it("lists only public app cards of push environments that are up, to any origin (K-1118)", async () => {
  await setup();
  const response = await send("/public/cards.json", { headers: { origin: "https://kitshn.com" } });
  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  // The zone's Browser Cache TTL would raise a max-age to hours; only the edge copy keeps one.
  expect(response.headers.get("cache-control")).toBe("no-store");
  const again = await send("/public/cards.json", { method: "HEAD" });
  expect(again.status).toBe(200);
  expect(again.headers.get("cache-control")).toBe("no-store");
  expect(await again.text()).toBe("");
  expect(await response.json()).toEqual({
    cards: [
      { name: "brew", address: "brew.example.com", kind: "site.compose", icon: null },
      {
        name: "tick3d",
        address: "tick3d.example.com",
        kind: "site.static",
        icon: `data:image/png;base64,${btoa(String.fromCharCode(...png))}`,
      },
    ],
  });
});

it("lists nothing when the Everyone circle has ended (K-1118)", async () => {
  expect(await listed(await setup({ endsAt: Date.now() - 1000 }))).toEqual([]);
});

it("lists nothing during a lockdown (K-1504, K-1118)", async () => {
  expect(await listed(await setup({}, "lockdown"))).toEqual([]);
});
