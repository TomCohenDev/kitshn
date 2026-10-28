import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { Notification } from "../src/core/notifications.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

afterEach(() => vi.restoreAllMocks());

const call = async (path: string, body?: object) =>
  send(path, {
    method: body ? "POST" : "GET",
    headers: {
      "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/** A subscription with real browser keys, as a browser sends it. */
async function browserDevice(endpoint = "https://push.example.com/send/one") {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return {
    endpoint,
    p256dh: b64url(raw),
    auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
    label: "Pixel",
  };
}

const failed: Notification = {
  id: 1,
  source: "deploy",
  key: "shop",
  episode: "d1",
  card: null,
  recipients: { _tag: "owner" },
  level: "error",
  priority: "normal",
  title: "Deploy of shop failed",
  text: "",
  actions: [],
  state: "open",
  openedAt: 0,
  closedAt: null,
  snoozedUntil: null,
};

interface Pushes {
  flushPushes(): Promise<void>;
  pushQueue: Array<{ notification: Notification; device: number | null; tries: number }>;
  scheduleAlarm(): Promise<void>;
}

it("keeps the VAPID key out of the snapshot, checks the keys, limits the test push, and removes a device (K-1907)", async () => {
  stubAccessCerts();
  const device = await browserDevice();
  const key = (await (await call("/api/push/devices", {})).json()) as { publicKey: string };
  expect(key.publicKey.length).toBeGreaterThan(60);
  const jwk = await runInDurableObject(env.KITSHN.getByName("kitshn"), (_, state) =>
    state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'push_vapid_jwk'").one(),
  );
  const { d } = JSON.parse(jwk.value) as { d: string };
  expect(await (await call("/api/state")).text()).not.toContain(d);

  expect(
    (await call("/api/push/subscribe", { ...device, endpoint: "http://plain.example.com" })).status,
  ).toBe(400);
  expect((await call("/api/push/subscribe", { ...device, auth: "c2hvcnQ" })).status).toBe(400);
  expect((await call("/api/push/subscribe", { ...device, p256dh: "BKey" })).status).toBe(400);
  expect((await call("/api/push/subscribe", device)).status).toBe(200);
  const listed = (await (await call("/api/push/devices", { mine: device.endpoint })).json()) as {
    devices: Array<{ id: number; label: string; mine: boolean; lastOkAt: number | null }>;
  };
  expect(listed.devices).toEqual([expect.objectContaining({ label: "Pixel", mine: true, lastOkAt: null })]);
  expect(JSON.stringify(listed)).not.toContain(device.endpoint);

  expect((await call("/api/push/test", {})).status).toBe(200);
  expect((await call("/api/push/test", {})).status).toBe(429);

  expect((await call("/api/push/unsubscribe", { id: listed.devices[0]?.id })).status).toBe(200);
  const after = (await (await call("/api/push/devices", {})).json()) as { devices: Array<unknown> };
  expect(after.devices).toEqual([]);
});

it("deletes a device that the push service no longer takes (K-1907)", async () => {
  stubAccessCerts();
  expect((await call("/api/push/subscribe", await browserDevice())).status).toBe(200);
  vi.restoreAllMocks();
  // 403: the subscription belongs to another key, for example after a restore (K-1831).
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 403 }));
  const left = await runInDurableObject(env.KITSHN.getByName("kitshn"), async (instance, state) => {
    const kitshn = instance as unknown as Pushes;
    kitshn.pushQueue = [{ notification: failed, device: null, tries: 0 }];
    await kitshn.flushPushes();
    return state.storage.sql.exec("SELECT id FROM push_subscriptions").toArray().length;
  });
  expect(left).toBe(0);
});

it("sends at most 5 pushes in one run and keeps the rest for the next alarm (K-1907, K-406)", async () => {
  stubAccessCerts();
  for (const n of [1, 2, 3, 4, 5, 6, 7])
    expect(
      (await call("/api/push/subscribe", await browserDevice(`https://push.example.com/send/${n}`))).status,
    ).toBe(200);
  vi.restoreAllMocks();
  const sent = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(null, { status: 201 }));
  const waiting = await runInDurableObject(env.KITSHN.getByName("kitshn"), async (instance) => {
    const kitshn = instance as unknown as Pushes;
    kitshn.scheduleAlarm = async () => {};
    kitshn.pushQueue = [{ notification: failed, device: null, tries: 0 }];
    await kitshn.flushPushes();
    return kitshn.pushQueue.length;
  });
  expect(sent).toHaveBeenCalledTimes(5);
  expect(waiting).toBe(2);
});
