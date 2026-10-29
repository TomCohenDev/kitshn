import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Circle } from "../src/core/model.ts";
import { type StateExport, stateExport } from "../src/worker/backups.ts";
import { MIGRATIONS } from "../src/worker/migrations.ts";
import { IMPORT_OBJECT } from "../src/worker/state-import.ts";
import { send } from "./access.ts";

/** K-1833: an empty install takes a state export of the same account; anything else is refused and changes nothing. */

type Instance = { runImport(): Promise<{ state: string; reason: string | null }>; load(): void };

const circle: Circle = {
  id: "friends",
  name: "Friends",
  color: "#7c3aed",
  level: "view",
  members: [{ _tag: "email", email: "friend@example.com" }],
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x: 900,
  y: 900,
  r: 200,
};

/** An export of the install `name`, with one more circle than the first start. */
const exportOf = (name: string) =>
  runInDurableObject(env.KITSHN.getByName(name), (instance, durable) => {
    durable.storage.sql.exec(
      "INSERT INTO circles (id, body) VALUES (?, ?)",
      circle.id,
      JSON.stringify(circle),
    );
    (instance as unknown as Instance).load();
    return stateExport(durable.storage.sql, env.CLOUDFLARE_ACCOUNT_ID, MIGRATIONS.length, 1_000);
  });

const upload = async (state: unknown) =>
  env.BUCKET!.put(
    IMPORT_OBJECT,
    await new Response(
      new Blob([JSON.stringify(state)]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );

/** Runs the import into the install `name`, and reads what it holds after. */
const importInto = (name: string, before?: (sql: SqlStorage) => void) =>
  runInDurableObject(env.KITSHN.getByName(name), async (instance, durable) => {
    before?.(durable.storage.sql);
    const outcome = await (instance as unknown as Instance).runImport();
    const sql = durable.storage.sql;
    return {
      outcome,
      circles: sql
        .exec<{ id: string }>("SELECT id FROM circles ORDER BY id")
        .toArray()
        .map((row) => row.id),
      history: sql
        .exec<{ summary: string }>("SELECT summary FROM revisions")
        .toArray()
        .map((row) => row.summary),
      version: sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'").one().value,
    };
  });

describe("state import (K-1833)", () => {
  it("rebuilds an empty install from an export, records it in History, and drops the file", async () => {
    await upload(await exportOf("source-a"));
    const after = await importInto("target-a");
    expect(after.outcome).toEqual({ state: "done", reason: null });
    expect(after.circles).toContain("friends");
    // The History of the export comes along, and the import is its newest row.
    expect(after.history.at(-1)).toMatch(/^Imported the state of 1970-01-01T00:00:01.000Z/);
    expect(after.version).toBe(String(MIGRATIONS.length));
    expect(await env.BUCKET!.head(IMPORT_OBJECT)).toBeNull();
  });

  it("imports an export of an older schema and runs the later migrations", async () => {
    const full = await exportOf("source-b");
    const old: StateExport = {
      ...full,
      schemaVersion: 20,
      tables: {
        circles: full.tables["circles"]!,
        resources: full.tables["resources"]!,
        places: full.tables["places"]!,
        meta: [{ key: "schema_version", value: "20" }],
      },
    };
    await upload(old);
    const after = await importInto("target-b");
    expect(after.outcome.state).toBe("done");
    expect(after.version).toBe(String(MIGRATIONS.length));
  });

  it("refuses another account, a newer schema, an install in use and an unknown table, and changes nothing", async () => {
    const state = await exportOf("source-c");
    const refusals: Array<[unknown, RegExp, ((sql: SqlStorage) => void)?]> = [
      [{ ...state, account: "another-account" }, /not of this one/],
      [{ ...state, schemaVersion: MIGRATIONS.length + 1 }, /newer than this kitshn/],
      [state, /it has machines/, (sql) => sql.exec("INSERT INTO machines (id, body) VALUES ('m', '{}')")],
      [{ ...state, tables: { ...state.tables, strange: [{ id: "x" }] } }, /does not know/],
    ];
    for (const [index, [file, reason, before]] of refusals.entries()) {
      await upload(file);
      const after = await importInto(`target-c${index}`, before);
      expect(after.outcome).toEqual({ state: "refused", reason: expect.stringMatching(reason) });
      expect(after.circles).not.toContain("friends");
      expect(after.history).not.toContainEqual(expect.stringMatching(/^Imported/));
    }
  });
});

describe("import status (K-1833)", () => {
  it("answers without a login with the state alone", async () => {
    const response = await send("/join/import-status");
    expect([response.status, await response.json()]).toEqual([200, { state: "none" }]);
  });
});
