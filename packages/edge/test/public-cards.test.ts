import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Circle, Resource } from "../src/core/model.ts";
import { send } from "./access.ts";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]);

it("lists only public app cards of push environments, to any origin (K-1116)", async () => {
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (_, state) => {
    const sql = state.storage.sql;
    const [row] = sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = 'everyone'").toArray();
    const everyone = JSON.parse(row!.body) as Circle;
    // "everyone" in an "all must match" circle with an IP range is not public.
    const office: Circle = {
      ...everyone,
      id: "office",
      name: "Office",
      match: "all",
      members: [{ _tag: "everyone" }, { _tag: "ip", range: "10.0.0.0/8" }],
      x: everyone.x + 10_000,
    };
    sql.exec("INSERT INTO circles (id, body) VALUES (?, ?)", office.id, JSON.stringify(office));
    const card = (id: string, kind: Resource["kind"], circle: Circle, environment: string | null) => {
      const resource: Resource = {
        id,
        kind,
        name: id,
        addresses: [`${id}.example.com`, `${id}.example.org`],
        status: "running",
        group: null,
        machine: null,
      };
      sql.exec("INSERT INTO resources (id, body) VALUES (?, ?)", id, JSON.stringify(resource));
      sql.exec("INSERT INTO places (id, x, y) VALUES (?, ?, ?)", id, circle.x, circle.y);
      if (environment === null) return;
      sql.exec(
        `INSERT INTO deploys (id, repo, environment, resource_id, address, script, kind, sha, state, expires_at)
         VALUES (?, 'o/r', ?, ?, '', '', 'deploy', 'abc', 'done', 0)`,
        `deploy-${id}`,
        environment,
        id,
      );
    };
    card("tick3d", "site.static", everyone, "prod");
    card("brew", "site.compose", everyone, "prod");
    card("riffle-pr-4", "site.static", everyone, "pr-4");
    card("never-deployed", "site.worker", everyone, null);
    card("notes", "page", everyone, "prod");
    card("office-app", "site.static", office, "prod");
    card("private-app", "site.static", { ...everyone, x: everyone.x + 50_000 }, "prod");
    sql.exec("INSERT INTO icons (id, type, hash, bytes) VALUES ('tick3d', 'image/png', 'h', ?)", png);
  });
  // The Durable Object reads the state again when it starts.
  await evictDurableObject(stub);

  const response = await send("/public/cards.json", { headers: { origin: "https://kitshn.com" } });
  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
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
