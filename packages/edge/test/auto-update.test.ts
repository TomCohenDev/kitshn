import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ProviderReport } from "@kitshn/local";
import { afterEach, expect, it, vi } from "vitest";
import type { Machine } from "../src/core/machine.ts";
import { type Circle, OWNER_CIRCLE_ID, type Resource } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

const NEW = "aaaaaaaaaaaa";
const OLD = "bbbbbbbbbbbb";
const machine: Machine = {
  key: { kind: "public", publicKey: "x", fingerprint: "f", since: 0 },
  id: "auto",
  name: "auto",
  labels: [],
  order: 0,
  serviceTokenId: "token-auto",
  clientId: "auto.access",
  tunnelId: "tunnel-auto",
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** The machine "auto" with its card in the Owner circle, so the owner has control on it (K-614). */
async function setup() {
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec("DELETE FROM providers");
    state.storage.sql.exec("DELETE FROM jobs WHERE machine_id = 'auto'");
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO machines (id, body) VALUES (?, ?)",
      machine.id,
      JSON.stringify(machine),
    );
    const owner = JSON.parse(
      state.storage.sql.exec<{ body: string }>("SELECT body FROM circles WHERE id = ?", OWNER_CIRCLE_ID).one()
        .body,
    ) as Circle;
    const card: Resource = {
      id: machine.id,
      kind: "machine",
      name: machine.name,
      addresses: [],
      status: "running",
      group: null,
      machine: machine.id,
    };
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO resources (id, body) VALUES (?, ?)",
      card.id,
      JSON.stringify(card),
    );
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO places (id, x, y) VALUES (?, ?, ?)",
      card.id,
      owner.x,
      owner.y,
    );
  });
  await evictDurableObject(stub);
  return stub;
}

const busyReport = (busy: boolean): ProviderReport => ({
  name: "t3",
  online: true,
  kinds: [{ id: "t3.app", name: "T3 app", levels: { view: "view", use: "use", control: "control" } }],
  commands: [],
  resources: [
    {
      id: "app",
      kind: "t3.app",
      name: "T3 on auto",
      status: "running",
      facts: [{ label: "busy", value: String(busy), role: "busy" }],
    },
  ],
});

it("queues one update for a BEHIND daemon that connects, and it waits while a provider is busy (K-627)", async () => {
  const stub = await setup();
  await runInDurableObject(stub, async (instance, state) => {
    // The Worker of a release, so there is a release to update to (K-617).
    const kitshn = instance as unknown as {
      env: { KITSHN_VERSION: string };
      setPresence(machineId: string, online: boolean): void;
    };
    kitshn.env = { ...kitshn.env, KITSHN_VERSION: NEW };
    const pair = new WebSocketPair();
    state.acceptWebSocket(pair[1], [machine.id, "machines"]);
    pair[0].accept();
    pair[1].serializeAttachment({
      kind: "machine",
      machineId: machine.id,
      since: Date.now(),
      challenge: "",
      check: "signed",
      answered: true,
      rotateBy: null,
      status: null,
      sample: null,
    });
    // As the accepted challenge does (K-1704).
    kitshn.setPresence(machine.id, true);
    const daemon = (message: object) => instance.webSocketMessage(pair[1], JSON.stringify(message));
    const status = {
      type: "status",
      status: {
        version: OLD,
        os: "Linux 6",
        arch: "x64",
        hostname: "auto",
        tunnel: "running",
        capabilities: ["update", "update-gz"],
      },
    };
    const jobs = () =>
      state.storage.sql
        .exec<{ state: string; command: string; when_idle: number }>(
          "SELECT state, command, when_idle FROM jobs WHERE machine_id = ?",
          machine.id,
        )
        .toArray();
    try {
      await daemon({ type: "providers", providers: [busyReport(true)] });
      await daemon(status);
      await daemon(status);
      expect(jobs()).toEqual([
        { state: "queued", command: JSON.stringify({ kind: "update", version: NEW }), when_idle: 1 },
      ]);
      await daemon({ type: "providers", providers: [busyReport(false)] });
      expect(jobs().map((job) => job.state)).toEqual(["sent"]);
    } finally {
      // An open socket keeps the Durable Object busy, and the next test evicts it.
      pair[1].close(1000, "test over");
    }
  });
});

it("turns Update daemon automatically off in one revision that History can undo (K-626)", async () => {
  stubAccessCerts();
  await setup();
  const owner = await accessToken("admin-aud", { email: "owner@example.com" });
  const post = (path: string, body: object) =>
    send(path, {
      method: "POST",
      headers: { "cf-access-jwt-assertion": owner, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const stored = () =>
    runInDurableObject(env.KITSHN.getByName("kitshn"), (_, state) => {
      const body = JSON.parse(
        state.storage.sql.exec<{ body: string }>("SELECT body FROM machines WHERE id = ?", machine.id).one()
          .body,
      ) as Machine;
      const revision = state.storage.sql
        .exec<{ id: number; summary: string }>("SELECT id, summary FROM revisions ORDER BY id DESC LIMIT 1")
        .one();
      return { autoUpdate: body.autoUpdate, revision };
    });
  expect((await post(`/api/machines/${machine.id}`, { autoUpdate: false })).status).toBe(200);
  const off = await stored();
  expect(off.autoUpdate).toBe(false);
  expect(off.revision.summary).toContain("Turned off Update daemon automatically for auto");
  expect((await post("/api/undo", { revision: off.revision.id })).status).toBe(200);
  expect((await stored()).autoUpdate).toBeUndefined();
});
