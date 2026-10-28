import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { type Change, type Forget, invert } from "../core/changes.ts";
import { type Circle, type Resource, type Stack, type State, shareKey } from "../core/model.ts";
import { seed } from "../core/seed.ts";
import { MIGRATIONS, levelSummaries, migrate } from "./migrations.ts";

const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);

describe("Durable Object migrations", () => {
  it("builds a new database to the newest version", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    expect(migrate((query) => db.exec(query), 0)).toBe(MIGRATIONS.length);
    expect(columns(db, "tunnel_objects")).toEqual(["machine_id", "body", "error", "applied", "retry_at"]);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: String(MIGRATIONS.length),
    });
  });

  it("moves a database from before the migrations forward and keeps its rows", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("CREATE TABLE tunnel_objects (machine_id TEXT PRIMARY KEY, body TEXT NOT NULL, error TEXT)");
    db.exec(
      "CREATE TABLE dns_objects (address TEXT PRIMARY KEY, record_id TEXT NOT NULL, content TEXT NOT NULL, error TEXT)",
    );
    db.exec("CREATE TABLE route_objects (address TEXT PRIMARY KEY, route_id TEXT NOT NULL, error TEXT)");
    db.exec(`INSERT INTO tunnel_objects VALUES ('m1', '{"ok":1}', NULL), ('m2', '{"new":1}', 'failed')`);
    migrate((query) => db.exec(query), 0);
    expect(db.prepare("SELECT machine_id, applied FROM tunnel_objects ORDER BY machine_id").all()).toEqual([
      { machine_id: "m1", applied: '{"ok":1}' },
      { machine_id: "m2", applied: "" },
    ]);
  });

  it("runs nothing when the database is current, and refuses a newer one", () => {
    const run: Array<string> = [];
    expect(migrate((query) => run.push(query), MIGRATIONS.length)).toBe(MIGRATIONS.length);
    expect(run).toEqual([]);
    expect(() => migrate(() => undefined, MIGRATIONS.length + 1)).toThrow(/newer/);
  });
});

describe("migration 12: History words a new level of a share apart (K-1508)", () => {
  const her: Circle = {
    id: "her",
    name: "Her",
    color: "#FF5277",
    level: "use",
    members: [{ _tag: "email", email: "her@example.com" }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 400,
    y: 0,
    r: 200,
  };
  const box: Resource = {
    id: "box",
    kind: "machine",
    name: "box",
    addresses: [],
    status: "running",
    group: null,
    machine: null,
  };
  const s = seed(["owner@example.com"], "kit.example.com");
  // The state now: box sits in Her at view, after a drop (1), a new level (2) and its undo and redo (3, 4).
  const now: State = {
    circles: new Map([...s.circles, her].map((circle) => [circle.id, circle])),
    resources: new Map([...s.resources, box].map((resource) => [resource.id, resource])),
    places: new Map([...s.places, ["box", { x: 400, y: 0 }]]),
    shareSettings: new Map([[shareKey("box", "her"), { level: "view", endsAt: null }]]),
    stacks: new Map(),
    paused: null,
    machines: new Map(),
  };
  const toView: Change = {
    _tag: "shareSetting",
    id: shareKey("box", "her"),
    before: null,
    after: { level: "view", endsAt: null },
  };
  const row = (id: number, summary: string, changes: ReadonlyArray<Change | Forget>) => ({
    id,
    summary,
    changes: JSON.stringify(changes),
  });
  const rows = [
    row(5, "Deployed riffle", []),
    row(4, "box: + Her · view", [toView]),
    row(3, "Undo #2: box: + Her · use", invert([toView])),
    row(2, "box: + Her · view", [toView]),
    row(1, "box: + Her · use", [{ _tag: "place", id: "box", before: null, after: { x: 400, y: 0 } }]),
  ];

  it("rewrites only the summaries of a new level, from the stored changes, and keeps undo labels", () => {
    expect(levelSummaries(now, rows)).toEqual({
      updates: [
        { id: 4, summary: "box: Her · use → view" },
        { id: 3, summary: "Undo #2: box: Her · view → use" },
        { id: 2, summary: "box: Her · use → view" },
      ],
      unchanged: 2,
      failed: 0,
      errors: [],
    });
    expect(levelSummaries(now, [row(2, "box: + Her · view and moved it", [toView])]).updates).toEqual([
      { id: 2, summary: "box: Her · use → view and moved it" },
    ]);
  });

  it("counts a row that the stored changes do not explain as failed, and finds nothing more on a second run", () => {
    // Without the card, the walk back cannot rebuild the share that the stored text names.
    const forgotten = { ...now, resources: new Map(s.resources.map((resource) => [resource.id, resource])) };
    expect(levelSummaries(forgotten, rows.slice(0, 2))).toMatchObject({ updates: [], unchanged: 1, failed: 1 });
    expect(levelSummaries(now, [row(2, "box: + Her · use", [toView])])).toMatchObject({ updates: [], failed: 1 });
    const { updates } = levelSummaries(now, rows);
    const done = rows.map((old) => ({
      ...old,
      summary: updates.find((update) => update.id === old.id)?.summary ?? old.summary,
    }));
    expect(levelSummaries(now, done)).toEqual({ updates: [], unchanged: 5, failed: 0, errors: [] });
  });

  it("keeps the text of a row whose rewording throws and goes on", () => {
    const broken: Change = { _tag: "stack", id: "s", before: {} as Stack, after: { id: "s", name: "s", members: ["box"] } };
    const run = levelSummaries(now, [
      row(9, "box: + Her · view", [toView]),
      row(8, "box: + Her · view", [broken]),
      rows[4]!,
    ]);
    expect(run).toMatchObject({ updates: [{ id: 9 }], unchanged: 1, failed: 1, errors: [{ id: 8 }] });
  });

  it("stops the walk at changes that it cannot apply, and counts that row and the older rows with a new share as failed", () => {
    for (const bad of [
      "null",
      "[null]",
      JSON.stringify([{ _tag: "circle", id: "her", after: null }]),
      JSON.stringify([{ _tag: "grow", id: "box", before: null, after: null }]),
      JSON.stringify([{ _tag: "pause", id: "pause", before: false, after: true }]),
    ]) {
      const run = levelSummaries(now, [
        row(9, "box: + Her · view", [toView]),
        { id: 8, summary: "box: + Her · use", changes: bad },
        row(7, "box: + Her · use", []),
        row(6, "Deployed riffle", []),
      ]);
      expect(run).toMatchObject({
        updates: [{ id: 9, summary: "box: Her · use → view" }],
        unchanged: 1,
        failed: 2,
        errors: [{ id: 8 }],
      });
    }
  });
});
