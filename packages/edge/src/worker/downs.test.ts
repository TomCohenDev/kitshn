import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { REPLACED, failQueuedDowns, removalDown, requeueDowns } from "./downs.ts";
import { migrate } from "./migrations.ts";

function jobs() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  migrate((query) => db.exec(query), 0);
  const sql = (query: string, ...bindings: Array<string | number | null>) => db.prepare(query).all(...bindings);
  const add = (command: object, state: string) =>
    Number(
      db
        .prepare(
          `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, output)
           VALUES ('m1', '[]', ?, ?, 0, 0, '{}', '{}', '') RETURNING id`,
        )
        .get(JSON.stringify(command), state)?.["id"],
    );
  const state = (id: number) => db.prepare("SELECT state, output FROM jobs WHERE id = ?").get(id);
  return { sql, add, state };
}

const down = { kind: "compose-down", project: "app", name: "app", removeData: false };
const redeploy = { kind: "compose-redeploy", project: "app" };

describe("removal downs (K-909)", () => {
  it("an undo replaces a queued stop, and the restart runs after it", () => {
    const { sql, add, state } = jobs();
    const stop = add(down, "queued");
    failQueuedDowns(sql, "app", "undone");
    const start = add(redeploy, "queued");
    expect(state(stop)).toEqual({ state: "failed", output: "undone" });
    expect(state(start)).toMatchObject({ state: "queued" });
    expect(removalDown(sql, "app")).toEqual({ id: stop, state: "failed" });
  });

  it("a newer deploy wins over a stop that waits or that the machine had when it went offline", () => {
    const { sql, add, state } = jobs();
    const waiting = add(down, "queued");
    const sent = add(down, "sent");
    failQueuedDowns(sql, "app", REPLACED);
    add({ kind: "compose", project: "app" }, "queued");
    requeueDowns(sql, "m1");
    expect(state(waiting)).toEqual({ state: "failed", output: REPLACED });
    expect(state(sent)).toEqual({ state: "failed", output: REPLACED });
  });

  it("a stop that the machine had goes out again after a reconnect, when nothing newer exists", () => {
    const { sql, add, state } = jobs();
    const sent = add(down, "sent");
    const other = add({ ...down, project: "other" }, "sent");
    add({ kind: "compose", project: "other" }, "queued");
    requeueDowns(sql, "m1");
    expect(state(sent)).toMatchObject({ state: "queued" });
    expect(state(other)).toMatchObject({ state: "failed" });
    expect(removalDown(sql, "app")).toEqual({ id: sent, state: "queued" });
  });
});
