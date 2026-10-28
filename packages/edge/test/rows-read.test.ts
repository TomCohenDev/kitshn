import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
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
  // The load reads the 200 recent revisions and the small tables; one snapshot scans the deploys once.
  expect(load).toBeLessThan(1000);
  expect(firstSnapshot).toBeLessThan(500 + 100);
  expect(rowsRead).toBeLessThan(100);
});
