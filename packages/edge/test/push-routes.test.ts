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

it("deletes a device on 404 or 410, and keeps it on 401 or 403 (K-1907)", async () => {
  stubAccessCerts();
  expect((await call("/api/push/subscribe", await browserDevice())).status).toBe(200);
  const left = async (status: number) => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    return runInDurableObject(env.KITSHN.getByName("kitshn"), async (instance, state) => {
      const kitshn = instance as unknown as Pushes;
      kitshn.scheduleAlarm = async () => {};
      kitshn.pushQueue = [{ notification: failed, device: null, tries: 0 }];
      await kitshn.flushPushes();
      return state.storage.sql.exec("SELECT id FROM push_subscriptions").toArray().length;
    });
  };
  // 403: the push service does not take kitshn's key; Rotate push key is the way out, not a silent delete.
  expect(await left(403)).toBe(1);
  expect(await left(410)).toBe(0);
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

it("sends at most 5 pushes in one alarm run, also when its reconcile opens another notification (K-1907, K-406)", async () => {
  stubAccessCerts();
  // Exactly 5 devices: a first flush empties the queue, so before the fix the reconcile's push started a second one.
  await runInDurableObject(env.KITSHN.getByName("kitshn"), (_i, state) => {
    state.storage.sql.exec("DELETE FROM push_subscriptions");
  });
  for (const n of [11, 12, 13, 14, 15])
    expect(
      (await call("/api/push/subscribe", await browserDevice(`https://push.example.com/send/${n}`))).status,
    ).toBe(200);
  vi.restoreAllMocks();
  const sent = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(null, { status: 201 }));
  const stub = env.KITSHN.getByName("kitshn");
  // workerd runs the alarms that kitshn schedules on its own. One of them between this setup and the run below would
  // send pushes too, so the test takes the pending alarm away, schedules none, and runs one alarm itself.
  await runInDurableObject(stub, async (instance, state) => {
    await state.storage.deleteAlarm();
    const kitshn = instance as unknown as Pushes & {
      sql(query: string, ...bindings: Array<string | number | null>): unknown;
      load(): void;
    };
    kitshn.scheduleAlarm = async () => {};
    // A push waits already, and the alarm's broadcast (an ended mute changes the bell) opens a deploy notification.
    kitshn.sql(
      "INSERT INTO resources (id, body) VALUES ('shop', ?)",
      JSON.stringify({
        id: "shop",
        kind: "site.static",
        name: "shop",
        addresses: [],
        status: "running",
        group: null,
        machine: null,
      }),
    );
    kitshn.sql(
      `INSERT INTO deploys (id, repo, environment, resource_id, address, script, kind, sha, state, expires_at, reason)
       VALUES ('d-shop', 'o/shop', 'prod', 'shop', 'shop.example.com', 'kitshn-shop', 'deploy', 'abc', 'failed', 0, 'x')`,
    );
    kitshn.sql(
      "INSERT INTO notification_mutes (card_id, source, until) VALUES ('shop', 'uptime', ?)",
      Date.now() - 1,
    );
    kitshn.load();
    kitshn.pushQueue = [{ notification: failed, device: null, tries: 0 }];
  });
  sent.mockClear();
  await runInDurableObject(stub, (instance) => instance.alarm());
  const pushes = sent.mock.calls.filter(([input]) =>
    String(input instanceof Request ? input.url : input).includes("push.example.com"),
  );
  expect(pushes).toHaveLength(5);
});
