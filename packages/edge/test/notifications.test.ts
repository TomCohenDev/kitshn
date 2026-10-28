import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Resource } from "../src/core/model.ts";

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
