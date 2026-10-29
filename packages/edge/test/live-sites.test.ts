import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { Machine } from "../src/core/machine.ts";
import { type Circle, OWNER_CIRCLE_ID, type Resource } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

/** K-1131: the site wizard only makes new sites, through one service that queues `kitshn expose --new`. */

const machine: Machine = {
  id: "vps",
  name: "vps",
  labels: [],
  order: 0,
  serviceTokenId: "token-vps",
  clientId: "vps.access",
  tunnelId: "tunnel-vps",
};

afterEach(() => vi.restoreAllMocks());

/** The machine and its card in the Owner circle, so the owner has control on it (K-614). */
async function setup() {
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO machines (id, body) VALUES (?, ?)",
      "vps",
      JSON.stringify(machine),
    );
    const owner = JSON.parse(
      state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = ?", OWNER_CIRCLE_ID).one()
        .body,
    ) as Circle;
    const card: Resource = {
      id: "vps",
      kind: "machine",
      name: "vps",
      addresses: [],
      status: "running",
      group: null,
      machine: "vps",
    };
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO resources (id, body) VALUES (?, ?)",
      "vps",
      JSON.stringify(card),
    );
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO places (id, x, y) VALUES (?, ?, ?)",
      "vps",
      owner.x,
      owner.y,
    );
  });
  await evictDurableObject(stub);
  return () =>
    runInDurableObject(stub, (_, state) =>
      state.storage.sql
        .exec<{ command: string }>("SELECT command FROM jobs ORDER BY id DESC LIMIT 1")
        .toArray()
        .map((row) => (JSON.parse(row.command) as { script: string }).script)
        .at(0),
    );
}

it("queues expose --new for a new name, and refuses a taken address or a bad server (K-1131)", async () => {
  stubAccessCerts();
  const lastScript = await setup();
  const token = await accessToken("admin-aud", { email: "owner@example.com" });
  const add = (body: object) =>
    send("/api/sites/live", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": token, "content-type": "application/json" },
      body: JSON.stringify({ machineId: "vps", dev: false, endsAt: null, ...body }),
    });
  const state = (await (
    await send("/api/state", { headers: { "cf-access-jwt-assertion": token } })
  ).json()) as {
    resources: ReadonlyArray<Resource>;
  };
  // A static site card that holds busy.<zone> already.
  const zone = state.resources
    .find((resource) => resource.kind === "kitshn.admin")
    ?.addresses[0]?.split(".")
    .slice(1)
    .join(".");
  if (!zone) throw new Error("no admin address");
  const busy: Resource = {
    id: "busy",
    kind: "site.static",
    name: "busy",
    addresses: [`busy.${zone}`],
    status: "running",
    group: null,
    machine: null,
  };
  await runInDurableObject(env.KITSHN.getByName("kitshn"), (_, storage) => {
    storage.storage.sql.exec(
      "INSERT OR REPLACE INTO resources (id, body) VALUES (?, ?)",
      "busy",
      JSON.stringify(busy),
    );
  });
  await evictDurableObject(env.KITSHN.getByName("kitshn"));
  const taken = "busy";

  const ok = await add({ server: "http://localhost:5173/app", name: "trek", endsAt: Date.now() + 3_600_000 });
  expect(ok.status, await ok.clone().text()).toBe(200);
  expect(await lastScript()).toContain("expose '5173' --name 'trek' --new");
  expect((await add({ server: "5174", name: taken })).status).toBe(409);
  expect((await add({ server: "http://localhost:0", name: "zero" })).status).toBe(400);
  expect((await add({ server: "https://foo.example.org", name: "far" })).status).toBe(400);
});
