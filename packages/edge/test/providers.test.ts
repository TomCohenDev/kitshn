import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ProviderReport } from "@kitshn/local";
import { afterEach, expect, it, vi } from "vitest";
import type { Machine } from "../src/core/machine.ts";
import { type Circle, OWNER_CIRCLE_ID, type Resource, providerCardId } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

const machine: Machine = {
  id: "vps",
  name: "vps",
  labels: [],
  order: 0,
  serviceTokenId: "token-vps",
  clientId: "vps.access",
  tunnelId: "tunnel-vps",
};

/** A daemon socket of the machine: signed (K-1704), or on its token alone (K-1708). */
const daemonSocket = (check: "signed" | "token") =>
  ({
    deserializeAttachment: () => ({
      kind: "machine",
      machineId: machine.id,
      since: 0,
      challenge: "",
      check,
      answered: true,
      rotateBy: null,
      status: null,
      sample: null,
    }),
    serializeAttachment() {},
    send() {},
    close() {},
  }) as unknown as WebSocket;

const report = (resources: ProviderReport["resources"], online = true): ProviderReport => ({
  name: "t3",
  online,
  kinds: [{ id: "t3.app", name: "T3 app", levels: { view: "view", use: "use", control: "control" } }],
  commands: [{ id: "restart", title: "Restart server", kinds: ["t3.app"], confirm: true }],
  resources,
});
const app = { id: "app", kind: "t3.app", name: "T3 on vps", status: "running" } as const;
const appId = providerCardId("vps", "t3", "app");

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup() {
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO machines (id, body) VALUES (?, ?)",
      "vps",
      JSON.stringify(machine),
    );
    // The machine card sits in the Owner circle, so the owner has control on it (K-614).
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
  const message = (check: "signed" | "token", providers: ReadonlyArray<ProviderReport>) =>
    runInDurableObject(stub, (instance) =>
      instance.webSocketMessage(daemonSocket(check), JSON.stringify({ type: "providers", providers })),
    );
  const card = () =>
    runInDurableObject(stub, (_, state) =>
      state.storage.sql
        .exec<{ body: string }>("SELECT body FROM resources WHERE id = ?", appId)
        .toArray()
        .map((row) => JSON.parse(row.body) as Resource)
        .at(0),
    );
  return { stub, message, card };
}

it("makes cards from a signed report only, shows an offline provider, and records a removal (K-704, K-705)", async () => {
  const { stub, message, card } = await setup();
  await message("token", [report([app])]);
  expect(await card()).toBeUndefined();

  await message("signed", [report([app])]);
  expect(await card()).toMatchObject({
    kind: "t3.app",
    machine: "vps",
    provider: { name: "t3", localId: "app" },
  });

  await message("signed", [report([app], false)]);
  expect((await card())?.status).toBe("offline");
  // A report that does not name the provider keeps its cards.
  await message("signed", []);
  expect(await card()).toBeDefined();

  await message("signed", [report([])]);
  expect(await card()).toBeUndefined();
  const summary = await runInDurableObject(
    stub,
    (_, state) =>
      state.storage.sql
        .exec<{ summary: string }>("SELECT summary FROM revisions ORDER BY id DESC LIMIT 1")
        .one().summary,
  );
  expect(summary).toBe("The providers of vps removed T3 on vps");
});

it("queues only a command that the card's provider has (K-707)", async () => {
  stubAccessCerts();
  const { message } = await setup();
  await message("signed", [report([app])]);
  const token = await accessToken("admin-aud", { email: "owner@example.com" });
  const job = (command: object) =>
    send("/api/jobs", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": token, "content-type": "application/json" },
      body: JSON.stringify({ machineId: "vps", command }),
    });
  const unknown = await job({ kind: "provider", provider: "t3", command: "format", resource: appId });
  expect(unknown.status).toBe(409);
  expect(await job({ kind: "provider", provider: "t3", command: "restart", resource: appId })).toHaveProperty(
    "status",
    200,
  );
  const stored = await runInDurableObject(env.KITSHN.getByName("kitshn"), (_, state) =>
    state.storage.sql.exec<{ command: string }>("SELECT command FROM jobs ORDER BY id DESC LIMIT 1").one(),
  );
  // The daemon gets the provider's own id of the card.
  expect(JSON.parse(stored.command)).toEqual({
    kind: "provider",
    provider: "t3",
    command: "restart",
    resource: "app",
  });
});
