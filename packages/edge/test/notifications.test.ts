import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { ADMIN_RESOURCE_ID, type Resource } from "../src/core/model.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

afterEach(() => vi.restoreAllMocks());

interface Kitshn {
  sql(
    query: string,
    ...bindings: Array<string | number | null>
  ): Array<Record<string, string | number | null>>;
  load(): void;
  broadcast(): void;
}

const deploy = (kitshn: Kitshn, id: string, state: string, reason: string | null) =>
  kitshn.sql(
    `INSERT INTO deploys (id, repo, environment, resource_id, address, script, kind, sha, state, expires_at, reason)
     VALUES (?, 'o/shop', 'prod', 'shop', 'shop.example.com', 'kitshn-shop', 'deploy', 'abc', ?, 0, ?)`,
    id,
    state,
    reason,
  );

it("opens a deploy notification when the newest deploy fails, and closes it after a good one (K-1904)", async () => {
  const stub = env.KITSHN.getByName("kitshn");
  const rows = await runInDurableObject(stub, (instance) => {
    const kitshn = instance as unknown as Kitshn;
    const shop: Resource = {
      id: "shop",
      kind: "site.static",
      name: "shop",
      addresses: ["shop.example.com"],
      status: "running",
      group: null,
      machine: null,
    };
    kitshn.sql("INSERT INTO resources (id, body) VALUES ('shop', ?)", JSON.stringify(shop));
    kitshn.load();
    const read = () =>
      kitshn.sql("SELECT state, title, text FROM notifications WHERE source = 'deploy' ORDER BY id");
    deploy(kitshn, "d1", "failed", "The build failed.");
    kitshn.broadcast();
    kitshn.broadcast();
    const failed = read();
    deploy(kitshn, "d2", "done", null);
    kitshn.broadcast();
    return { failed, after: read() };
  });
  expect(rows.failed).toEqual([{ state: "open", title: "Deploy of shop failed", text: "The build failed." }]);
  expect(rows.after.map((row) => row.state)).toEqual(["closed"]);
});

it("opens an uptime notification while a card is down, and closes it when it is up (K-1904)", async () => {
  const stub = env.KITSHN.getByName("notify-uptime");
  const states = await runInDurableObject(stub, (instance) => {
    const kitshn = instance as unknown as Kitshn & { uptimeCache: unknown };
    const shop: Resource = {
      id: "shop",
      kind: "site.static",
      name: "shop",
      addresses: ["shop.example.com"],
      status: "running",
      group: null,
      machine: null,
    };
    kitshn.sql("INSERT INTO resources (id, body) VALUES ('shop', ?)", JSON.stringify(shop));
    kitshn.load();
    const read = () =>
      kitshn.sql("SELECT state FROM notifications WHERE source = 'uptime'").map((row) => row.state);
    kitshn.sql("INSERT INTO uptime (card_id, up, failing_since, since) VALUES ('shop', 0, NULL, 1)");
    kitshn.uptimeCache = null;
    kitshn.broadcast();
    const down = read();
    kitshn.sql("DELETE FROM uptime WHERE card_id = 'shop'");
    kitshn.uptimeCache = null;
    kitshn.broadcast();
    return { down, up: read() };
  });
  expect(states).toEqual({ down: ["open"], up: ["closed"] });
});

it("keeps a dismissed notification closed for its episode, and opens a new one for the next (K-1905)", async () => {
  const stub = env.KITSHN.getByName("notify-dismiss");
  const states = await runInDurableObject(stub, (instance) => {
    const kitshn = instance as unknown as Kitshn & {
      setNotificationState(source: string, key: string, state: string): void;
    };
    const shop: Resource = {
      id: "shop",
      kind: "site.static",
      name: "shop",
      addresses: ["shop.example.com"],
      status: "running",
      group: null,
      machine: null,
    };
    kitshn.sql("INSERT INTO resources (id, body) VALUES ('shop', ?)", JSON.stringify(shop));
    kitshn.load();
    const read = () =>
      kitshn
        .sql("SELECT state FROM notifications WHERE source = 'deploy' ORDER BY id")
        .map((row) => row.state);
    deploy(kitshn, "d1", "failed", "The build failed.");
    kitshn.broadcast();
    kitshn.setNotificationState("deploy", "shop", "dismissed");
    // The same failed deploy is still the newest, so nothing opens again.
    kitshn.broadcast();
    const dismissed = read();
    deploy(kitshn, "d2", "failed", "The build failed again.");
    kitshn.broadcast();
    return { dismissed, next: read() };
  });
  expect(states).toEqual({ dismissed: ["dismissed"], next: ["dismissed", "open"] });
});

it("refuses a mute of a card that does not exist or of an unknown source (K-1905)", async () => {
  stubAccessCerts();
  const headers = {
    "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }),
    "content-type": "application/json",
  };
  const mute = (body: object) =>
    send("/api/notifications/mute", { method: "POST", headers, body: JSON.stringify(body) });
  expect((await mute({ card: "no-such-card", source: "deploy", until: null })).status).toBe(400);
  expect((await mute({ card: ADMIN_RESOURCE_ID, source: "anything", until: null })).status).toBe(400);
});

it("runs the later alarm steps when one throws, and tells the owner until it works again (K-406, K-1910)", async () => {
  const stub = env.KITSHN.getByName("alarm-steps");
  const result = await runInDurableObject(stub, async (instance) => {
    const kitshn = instance as unknown as Kitshn & Record<string, unknown> & { alarm(): Promise<void> };
    const ran: Array<string> = [];
    let gameDnsFails = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    kitshn["api"] = () => async () => [];
    const step = (name: string, calls: number) => async () => {
      ran.push(name);
      if (name === "syncGameDns" && gameDnsFails) throw new Error("zonePath takes one label.");
      return calls;
    };
    for (const name of ["fillAudiences", "refreshForeignPaths", "syncTunnels", "checkSites", "syncDns"])
      kitshn[name] = step(name, 0);
    kitshn["syncGameDns"] = step("syncGameDns", 4);
    kitshn["syncRoutes"] = step("syncRoutes", 0);
    kitshn["syncRedirects"] = step("syncRedirects", 0);
    kitshn["syncLauncher"] = step("syncLauncher", 0);
    let accessBudget = 0;
    kitshn["syncAccessLocked"] = async (_api: unknown, budget: number) => {
      ran.push("syncAccessLocked");
      accessBudget = budget;
    };
    const read = () => kitshn.sql("SELECT key, state FROM notifications WHERE source = 'alarm' ORDER BY id");
    await kitshn.alarm();
    const failed = {
      ran: [...ran],
      accessBudget,
      rows: read(),
      retryAt: kitshn.sql("SELECT value FROM meta WHERE key = 'alarm_retry_at'"),
    };
    gameDnsFails = false;
    await kitshn.alarm();
    return { failed, after: read() };
  });
  expect(result.failed.ran).toEqual([
    "fillAudiences",
    "refreshForeignPaths",
    "syncTunnels",
    "checkSites",
    "syncDns",
    "syncGameDns",
    "syncRoutes",
    "syncRedirects",
    "syncLauncher",
    "syncAccessLocked",
    "syncLauncher",
  ]);
  // The failed step counts its whole budget of 4, so Access keeps 40 - 4 - 16 - 3.
  expect(result.failed.accessBudget).toBe(17);
  expect(result.failed.rows).toEqual([{ key: "game DNS", state: "open" }]);
  expect(result.failed.retryAt).toHaveLength(1);
  expect(result.after).toEqual([{ key: "game DNS", state: "closed" }]);
});
