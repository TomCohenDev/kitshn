import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Resource } from "../src/core/model.ts";
import type { Usage } from "../src/core/usage.ts";
import { send } from "./access.ts";

interface Kitshn {
  sql(
    query: string,
    ...bindings: Array<string | number | null>
  ): Array<Record<string, string | number | null>>;
  load(): void;
  mintNotifyToken(card: string): string;
  broadcast(): void;
  limitsUsage: Usage | null;
  presence: Map<string, { online: boolean; lastSeen: number; os: null }>;
}

const card = (id: string): Resource => ({
  id,
  kind: "site.static",
  name: id,
  addresses: [`${id}.example.com`],
  status: "running",
  group: null,
  machine: null,
});

const post = (token: string, body: object) =>
  send("/notify", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

it("takes 30 app notifications an hour per card and for all cards together, then 429 with Retry-After (K-1908)", async () => {
  const tokens = await runInDurableObject(env.KITSHN.getByName("kitshn"), (instance) => {
    const kitshn = instance as unknown as Kitshn;
    for (const id of ["one", "two"])
      kitshn.sql("INSERT INTO resources (id, body) VALUES (?, ?)", id, JSON.stringify(card(id)));
    kitshn.load();
    return { one: kitshn.mintNotifyToken("one"), two: kitshn.mintNotifyToken("two") };
  });
  for (let i = 0; i < 20; i++) expect((await post(tokens.one, { title: `one ${i}` })).status).toBe(200);
  for (let i = 0; i < 10; i++) expect((await post(tokens.two, { title: `two ${i}` })).status).toBe(200);
  // Card two has room of its own, but all cards together have sent 30.
  const refused = await post(tokens.two, { title: "two 10" });
  expect(refused.status).toBe(429);
  expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
  // `resolved` closes the open notification of its key, and counts against no window.
  expect((await post(tokens.one, { title: "one 0", resolved: true })).status).toBe(200);
  const states = await runInDurableObject(env.KITSHN.getByName("kitshn"), (instance) =>
    (instance as unknown as Kitshn).sql(
      "SELECT state FROM notifications WHERE source = 'app' AND key = 'one:one 0'",
    ),
  );
  expect(states).toEqual([{ state: "closed" }]);
  expect((await post(tokens.one, { title: "x".repeat(101) })).status).toBe(400);
});

it("opens a limits notification at 80% and a machine notification after 15 minutes offline, and closes them (K-1910)", async () => {
  const states = await runInDurableObject(env.KITSHN.getByName("own-sources"), (instance) => {
    const kitshn = instance as unknown as Kitshn;
    const machine = { id: "box", name: "Box" };
    kitshn.sql(
      "INSERT INTO machines (id, body) VALUES ('box', ?)",
      JSON.stringify({
        ...machine,
        labels: [],
        order: 0,
        clientId: "c",
        tokenId: "t",
        tunnelId: "u",
        key: null,
      }),
    );
    kitshn.load();
    const row = (used: number) => ({
      label: "Durable Object rows read",
      used,
      limit: 100,
      period: "day" as const,
      unit: "count" as const,
      docs: "",
    });
    const read = () =>
      kitshn.sql(
        "SELECT source, state FROM notifications WHERE source IN ('limits', 'machine') ORDER BY source",
      );
    kitshn.limitsUsage = { at: 0, rows: [row(85)] };
    kitshn.presence.set("box", { online: false, lastSeen: Date.now() - 16 * 60_000, os: null });
    kitshn.broadcast();
    const open = read();
    kitshn.limitsUsage = { at: 1, rows: [row(10)] };
    kitshn.presence.set("box", { online: true, lastSeen: Date.now(), os: null });
    kitshn.broadcast();
    return { open, after: read() };
  });
  expect(states.open).toEqual([
    { source: "limits", state: "open" },
    { source: "machine", state: "open" },
  ]);
  expect(states.after).toEqual([
    { source: "limits", state: "closed" },
    { source: "machine", state: "closed" },
  ]);
});
