import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { Circle } from "../src/core/model.ts";
import type { RevisionView } from "../src/core/protocol.ts";
import { accessToken, send, stubAccessCerts } from "./access.ts";

afterEach(() => vi.restoreAllMocks());

/**
 * K-1302: the free plan reads 5,000,000 rows a day. A wake of the Durable Object (load) and each snapshot read a
 * bounded number of rows, not the whole revisions or deploys table.
 */
it("reads few rows on a wake and on each snapshot", async () => {
  stubAccessCerts();
  const stub = env.KITSHN.getByName("kitshn");
  let rowsRead = 0;
  const load = await runInDurableObject(stub, (instance, state) => {
    const sql = state.storage.sql;
    const now = Date.now();
    for (let i = 0; i < 2000; i++)
      sql.exec(
        "INSERT INTO revisions (at, actor, summary, changes, undoes) VALUES (?, ?, 'test', '[]', ?)",
        now,
        JSON.stringify({ _tag: "kitshn", reason: "test" }),
        i % 10 === 0 ? 1 : null,
      );
    for (let i = 0; i < 500; i++)
      sql.exec(
        `INSERT INTO deploys (id, repo, environment, resource_id, address, script, kind, sha, state, expires_at)
         VALUES (?, 'owner/repo', 'prod', 'card', 'card.example.com', 'kitshn-card', 'deploy', 'abc', 'done', ?)`,
        `rows-read-${i}`,
        now,
      );
    // Access rows and icons only the alarm and a snapshot read; a wake for a daemon sample reads neither.
    for (let i = 0; i < 300; i++)
      sql.exec(
        "INSERT INTO access_objects (key, cf_id, body, tried) VALUES (?, 'cf', '{}', '{}')",
        `rows-read-${i}`,
      );
    for (let i = 0; i < 100; i++)
      sql.exec(
        "INSERT INTO icons (id, type, hash, bytes) VALUES (?, 'image/png', 'h', x'00')",
        `rows-read-${i}`,
      );
    const exec = sql.exec.bind(sql);
    sql.exec = ((query: string, ...bindings: Array<SqlStorageValue>) => {
      const cursor = exec(query, ...bindings);
      const toArray = cursor.toArray.bind(cursor);
      cursor.toArray = () => {
        const rows = toArray();
        rowsRead += cursor.rowsRead;
        return rows;
      };
      return cursor;
    }) as typeof sql.exec;
    (instance as unknown as { load(): void }).load();
    return rowsRead;
  });
  const headers = {
    "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }),
  };
  rowsRead = 0;
  await send("/api/state", { headers });
  const firstSnapshot = rowsRead;
  rowsRead = 0;
  await send("/api/state", { headers });
  // A wake reads the small tables only; the first snapshot reads the 200 recent revisions and scans the deploys once.
  expect(load).toBeLessThan(100);
  expect(firstSnapshot).toBeLessThan(1000 + 500 + 300 + 100);
  expect(rowsRead).toBeLessThan(100);
});

/** What a wake does: the load, which leaves History unread. */
const wake = (stub: DurableObjectStub) =>
  runInDurableObject(stub, (instance) => (instance as unknown as { load(): void }).load());

it("applies and undoes right after a wake, before History is read", async () => {
  stubAccessCerts();
  const stub = env.KITSHN.getByName("kitshn");
  const headers = {
    "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }),
    "content-type": "application/json",
  };
  const circle: Circle = {
    id: "wake",
    name: "Wake",
    color: "#7c3aed",
    level: "view",
    members: [],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 3000,
    y: 3000,
    r: 200,
  };
  await wake(stub);
  const applied = await send("/api/apply", {
    method: "POST",
    headers,
    body: JSON.stringify({ edits: [{ _tag: "circle", id: circle.id, after: circle }] }),
  });
  expect(applied.status).toBe(200);
  const { revision } = (await applied.json()) as { revision: number };
  await wake(stub);
  const undone = await send("/api/undo", { method: "POST", headers, body: JSON.stringify({ revision }) });
  expect(undone.status).toBe(200);
  const state = (await (await send("/api/state", { headers })).json()) as {
    revisions: ReadonlyArray<RevisionView>;
    circles: ReadonlyArray<{ id: string }>;
  };
  expect(state.circles.map((item) => item.id)).not.toContain("wake");
  const [undo, ...older] = state.revisions;
  expect(undo?.undoes).toBe(revision);
  expect(older.find((item) => item.id === revision)?.undoneBy).toBe(undo?.id);
  expect(new Set(state.revisions.map((item) => item.id)).size).toBe(state.revisions.length);
});
