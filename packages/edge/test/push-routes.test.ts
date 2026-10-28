import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
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

const device = {
  endpoint: "https://push.example.com/send/one",
  p256dh: "BKey",
  auth: "auth",
  label: "Pixel",
};

it("keeps the VAPID key out of the snapshot, limits the test push, and lets the owner remove a device (K-1907)", async () => {
  stubAccessCerts();
  const key = (await (await call("/api/push")).json()) as { publicKey: string };
  expect(key.publicKey.length).toBeGreaterThan(60);
  const jwk = await runInDurableObject(env.KITSHN.getByName("kitshn"), (_, state) =>
    state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'push_vapid_jwk'").one(),
  );
  const { d } = JSON.parse(jwk.value) as { d: string };
  expect(await (await call("/api/state")).text()).not.toContain(d);

  expect(
    (await call("/api/push/subscribe", { ...device, endpoint: "http://plain.example.com" })).status,
  ).toBe(400);
  expect((await call("/api/push/subscribe", device)).status).toBe(200);
  const listed = (await (await call(`/api/push?mine=${encodeURIComponent(device.endpoint)}`)).json()) as {
    devices: Array<{ id: number; label: string; mine: boolean; lastOkAt: number | null }>;
  };
  expect(listed.devices).toEqual([expect.objectContaining({ label: "Pixel", mine: true, lastOkAt: null })]);
  expect(JSON.stringify(listed)).not.toContain(device.endpoint);

  expect((await call("/api/push/test", {})).status).toBe(200);
  expect((await call("/api/push/test", {})).status).toBe(429);

  expect((await call("/api/push/unsubscribe", { id: listed.devices[0]?.id })).status).toBe(200);
  const after = (await (await call("/api/push")).json()) as { devices: Array<unknown> };
  expect(after.devices).toEqual([]);
});

it("deletes a device that the push service no longer knows (K-1907)", async () => {
  stubAccessCerts();
  const browser = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", browser.publicKey)) as ArrayBuffer);
  const p256dh = btoa(String.fromCharCode(...raw))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  expect(
    (await call("/api/push/subscribe", { ...device, p256dh, auth: "AAAAAAAAAAAAAAAAAAAAAA" })).status,
  ).toBe(200);
  vi.restoreAllMocks();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 410 }));
  const left = await runInDurableObject(env.KITSHN.getByName("kitshn"), async (instance, state) => {
    const kitshn = instance as unknown as {
      queuePush(notification: object): void;
      flushPushes(): Promise<void>;
      pushQueue: Array<unknown>;
    };
    kitshn.pushQueue = [
      {
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
      },
    ];
    await kitshn.flushPushes();
    return state.storage.sql.exec("SELECT id FROM push_subscriptions").toArray().length;
  });
  expect(left).toBe(0);
});
