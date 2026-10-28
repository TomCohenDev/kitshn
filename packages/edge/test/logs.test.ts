import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LogLine } from "../src/core/logs.ts";
import type { Machine, MachineStatus } from "../src/core/machine.ts";
import type { Resource } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

/** K-1804, K-1805: log searches and tails go between a map, the Durable Object and the daemon of the card. */

const stub = () => env.KITSHN.getByName("kitshn");

async function composeCard(machineId: string, card: string) {
  await runInDurableObject(stub(), (_instance, durable) => {
    const machine: Machine = {
      id: machineId,
      name: machineId,
      labels: ["deploy"],
      order: 0,
      serviceTokenId: `token-${machineId}`,
      clientId: `${machineId}.access`,
      tunnelId: `tunnel-${machineId}`,
    };
    const resource: Resource = {
      id: card,
      kind: "site.compose",
      name: card,
      addresses: [`${card}.example.com`],
      status: "running",
      group: null,
      machine: machineId,
    };
    durable.storage.sql.exec(
      "INSERT INTO machines (id, body) VALUES (?, ?)",
      machineId,
      JSON.stringify(machine),
    );
    durable.storage.sql.exec(
      "INSERT INTO resources (id, body) VALUES (?, ?)",
      card,
      JSON.stringify(resource),
    );
  });
  // The Durable Object reads machines and cards again when it starts.
  await evictDurableObject(stub());
}

/** A socket that the Durable Object accepted, and the messages that it sent on it. */
async function socket(tags: Array<string>, attachment: object) {
  const received: Array<Record<string, unknown>> = [];
  const server = await runInDurableObject(stub(), (_instance, durable) => {
    const pair = new WebSocketPair();
    durable.acceptWebSocket(pair[1], tags);
    pair[0].accept();
    pair[0].addEventListener("message", (event) => {
      received.push(JSON.parse(String(event.data)));
    });
    pair[1].serializeAttachment(attachment);
    return pair[1];
  });
  return { server, received };
}

const daemon = (machineId: string, capabilities: Array<string>) =>
  socket([machineId, "machines"], {
    kind: "machine",
    machineId,
    since: Date.now(),
    challenge: "",
    check: "signed",
    answered: true,
    rotateBy: null,
    status: {
      version: "1",
      os: "linux",
      arch: "x64",
      hostname: machineId,
      tunnel: "running",
      capabilities,
    } satisfies MachineStatus,
    sample: null,
  });

const fromDaemon = (server: WebSocket, message: object) =>
  runInDurableObject(stub(), (instance) => instance.webSocketMessage(server, JSON.stringify(message)));

const close = (server: WebSocket) =>
  runInDurableObject(stub(), async (instance) => {
    server.close(1001, "gone");
    await instance.webSocketClose(server);
  });

/** The messages arrive on the other end of the pair after the call returns. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const search = async (card: string, body: object) => {
  const response = await send(`/api/apps/${card}/logs`, {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

afterEach(() => vi.restoreAllMocks());

describe("Compose logs (K-1804, K-1805)", () => {
  it("sends a search to the card's daemon and answers with its lines", async () => {
    stubAccessCerts();
    await composeCard("m-search", "app-search");
    const { server, received } = await daemon("m-search", ["logs"]);
    const query = { tab: "app", text: "boom", from: 1000, to: 2000 };
    const answer = search("app-search", query);
    await vi.waitFor(() => expect(received.some((message) => message["type"] === "logs")).toBe(true));
    const request = received.find((message) => message["type"] === "logs");
    expect(request).toMatchObject({ project: "app-search", search: { text: "boom", from: 1000, to: 2000 } });
    const line: LogLine = { at: 1500, source: "web-1", text: "boom" };
    await fromDaemon(server, {
      type: "logs",
      id: request?.["id"],
      answer: { state: "lines", lines: [line], matched: 7 },
    });
    expect((await answer).body).toEqual({ answer: { state: "lines", lines: [line], matched: 7 } });
    await close(server);
  });

  it("refuses a daemon that cannot read logs, and a card that has none", async () => {
    stubAccessCerts();
    await composeCard("m-old", "app-old");
    const { server } = await daemon("m-old", ["compose"]);
    const old = await search("app-old", { tab: "app", text: "", from: 0, to: 1 });
    expect(old.body["answer"]).toMatchObject({
      state: "error",
      error: expect.stringMatching(/Update the daemon/),
    });
    await close(server);
    const none = await search("kitshn-admin", { tab: "app", text: "", from: 0, to: 1 });
    expect(none.status).toBe(409);
  });

  it("sends tail lines only to the map that holds the tail, and stops a tail that no map holds", async () => {
    await composeCard("m-tail", "app-tail");
    const machine = await daemon("m-tail", ["logs"]);
    const map = await socket(["map"], {
      kind: "map",
      caller: {
        visitor: { email: "owner@example.com", clientId: null, ip: null },
        actor: { _tag: "person", email: "owner@example.com" },
      },
      tails: [{ kind: "compose", id: "t1", machineId: "m-tail" }],
    });
    const line: LogLine = { at: 1, source: "web-1", text: "hello" };
    await fromDaemon(machine.server, { type: "tailLines", id: "t1", lines: [line], skipped: 2 });
    await fromDaemon(machine.server, { type: "tailLines", id: "lost", lines: [line], skipped: 0 });
    await settle();
    expect(map.received).toEqual([{ type: "tailLines", tail: "t1", lines: [line], skipped: 2 }]);
    expect(machine.received).toContainEqual({ type: "tailStop", id: "lost" });
    // A map that closes stops its tails on the daemon.
    await close(map.server);
    await settle();
    expect(machine.received).toContainEqual({ type: "tailStop", id: "t1" });
    await close(machine.server);
  });

  it("ends the tails of a machine whose connection closes", async () => {
    await composeCard("m-gone", "app-gone");
    const machine = await daemon("m-gone", ["logs"]);
    const map = await socket(["map"], {
      kind: "map",
      caller: {
        visitor: { email: "owner@example.com", clientId: null, ip: null },
        actor: { _tag: "person", email: "owner@example.com" },
      },
      tails: [{ kind: "compose", id: "t2", machineId: "m-gone" }],
    });
    await close(machine.server);
    await settle();
    expect(map.received).toContainEqual({
      type: "tailEnd",
      tail: "t2",
      reason: expect.stringMatching(/closed/),
    });
    await close(map.server);
  });
});
