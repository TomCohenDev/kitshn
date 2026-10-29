import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import {
  FORWARD_HEADERS,
  type Machine,
  type MachinePrivateKey,
  forwardText,
  newMachineKey,
  signText,
} from "../src/core/machine.ts";
import type { Circle, RightMode } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

afterEach(() => vi.restoreAllMocks());

/** The machine vps in the agent circle "agents" with these rights. */
async function setup(rights: Partial<Record<string, RightMode>>, key: MachinePrivateKey | null = null) {
  const machine: Machine = {
    ...(key ? { key: { kind: "public" as const, publicKey: key.x, fingerprint: "f", since: 0 } } : {}),
    id: "vps",
    name: "vps",
    labels: [],
    order: 0,
    serviceTokenId: "token-vps",
    clientId: "vps.access",
    tunnelId: "tunnel-vps",
  };
  const agents: Circle = {
    id: "agents",
    name: "Agents",
    color: "#ffcc00",
    level: "control",
    members: [{ _tag: "machine", machineId: "vps", rights }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 5000,
    y: 5000,
    r: 200,
  };
  const stub = env.KITSHN.getByName("kitshn");
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO machines (id, body) VALUES (?, ?)",
      "vps",
      JSON.stringify(machine),
    );
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO circles (id, body) VALUES (?, ?)",
      "agents",
      JSON.stringify(agents),
    );
    state.storage.sql.exec("DELETE FROM ask_events");
  });
  await evictDurableObject(stub);
}

/** One call as the daemon forwards it: the machine token, and the machine key's signature (K-1714). */
async function forwarded(key: MachinePrivateKey, method: string, path: string, nonce: string, body = "{}") {
  const at = Date.now();
  const labels = "{}";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(labels)));
  const labelsHash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const signature = await signText(
    key,
    forwardText("kit.example.com", "vps", { method, path, at, nonce, labelsHash }),
  );
  return send(path, {
    method,
    headers: {
      "cf-access-jwt-assertion": await accessToken("agent-aud", { common_name: "vps.access" }),
      "content-type": "application/json",
      [FORWARD_HEADERS.signature]: signature,
      [FORWARD_HEADERS.at]: String(at),
      [FORWARD_HEADERS.nonce]: nonce,
      [FORWARD_HEADERS.labels]: labels,
    },
    body,
  });
}

it("takes a call that the daemon forwarded and signed, with the right of its path, once per nonce (K-1714)", async () => {
  stubAccessCerts();
  const key = await newMachineKey();
  await setup({ deploys: { mode: "automatic" } }, key);
  const address = "/agent/cards/no-such-card/address";
  const off = await forwarded(key, "POST", address, "nonce-off-0123456789");
  expect(off.status).toBe(403);
  // A forwarded call cannot wait for the Owner, so an unset right refuses it too, and says how to fix it.
  expect(await off.json()).toEqual({
    error: expect.stringContaining('"adds pages" is not set'),
    need: "addsPages",
  });
  await setup({ deploys: { mode: "automatic" }, addsPages: { mode: "automatic" } }, key);
  const passed = await forwarded(
    key,
    "POST",
    address,
    "nonce-on-01234567890",
    JSON.stringify({ address: "x" }),
  );
  // The right passes; the path itself answers for the unknown card.
  expect((await passed.json()) as { error?: string }).toEqual({
    error: expect.not.stringMatching(/K-1714|adds pages/),
  });
  const again = await forwarded(key, "POST", address, "nonce-on-01234567890");
  expect(again.status).toBe(403);
  expect(await again.json()).toEqual({ error: expect.stringContaining("nonce") });
  const events = await runInDurableObject(env.KITSHN.getByName("kitshn"), (_, state) =>
    state.storage.sql
      .exec<{ action: string; target: string }>("SELECT action, target FROM ask_events ORDER BY id")
      .toArray(),
  );
  // A call whose signature or nonce fails is no call of the machine, so it writes no event.
  expect(events).toEqual([{ action: "forward", target: `POST ${address}` }]);
});

it("refuses the machine's own token on every agent path over HTTP without the daemon's signature (K-1714)", async () => {
  stubAccessCerts();
  await setup({ runsCommands: { mode: "automatic" }, deploys: { mode: "automatic" } });
  const token = await accessToken("agent-aud", { common_name: "vps.access" });
  const headers = { "cf-access-jwt-assertion": token, "content-type": "application/json" };
  for (const [method, path] of [
    ["GET", "/agent/state"],
    ["POST", "/agent/apply"],
    ["POST", "/agent/jobs"],
    ["GET", "/agent/jobs/1"],
    ["POST", "/agent/deploy"],
    ["POST", "/agent/repos/123"],
    ["POST", "/agent/library"],
  ] as const) {
    const response = await send(path, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) });
    expect(response.status, path).toBe(403);
  }
});
