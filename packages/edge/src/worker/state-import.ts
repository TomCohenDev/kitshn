// K-1833: rebuilds the state of an empty install from a state export of K-1831.
import type { StateExport } from "./backups.ts";
import { MIGRATIONS, migrate } from "./migrations.ts";

/** K-1833: the tables that make an install not empty; the first start fills none of them. */
const FILLED_BY_USE = ["machines", "deploys", "library", "repos"] as const;

/** The object that the import starts the bootstrap with: `import/state.json.gz` in the bucket. */
export const IMPORT_OBJECT = "import/state.json.gz";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A table or column name of the export; it goes into SQL, so only plain names pass. */
const plainName = (name: string) => /^[a-z_][a-z0-9_]*$/.test(name);

/** K-1833: the export, or why kitshn refuses it. */
export function readExport(value: unknown, account: string): StateExport | string {
  if (!isRecord(value) || value["format"] !== "kitshn-state" || value["version"] !== 1)
    return "The file is no kitshn state export (K-1831).";
  const { schemaVersion, exportedAt, tables } = value;
  if (typeof value["account"] !== "string")
    return "The export names no Cloudflare account, so kitshn cannot check that it belongs here (K-1833).";
  if (value["account"] !== account)
    return `The export is of the Cloudflare account ${value["account"]}, not of this one; v1 imports into the same account only (K-1834).`;
  if (typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1)
    return "The export names no schema version.";
  if (schemaVersion > MIGRATIONS.length)
    return `The export has schema version ${schemaVersion}, newer than this kitshn (${MIGRATIONS.length}); update kitshn first.`;
  if (typeof exportedAt !== "number" || !isRecord(tables)) return "The export has no time or no tables.";
  for (const [name, rows] of Object.entries(tables)) {
    if (!plainName(name) || !Array.isArray(rows) || !rows.every(isRecord))
      return `The table ${name} of the export is not a list of rows.`;
    for (const row of rows)
      for (const column of Object.keys(row))
        if (!plainName(column)) return `The column ${column} of ${name} is not a plain name.`;
  }
  return value as unknown as StateExport;
}

/** K-1833: why this install is not empty, or null. Only the cards of the first start may exist. */
export function notEmptyReason(sql: SqlStorage, firstStartCards: ReadonlyArray<string>): string | null {
  for (const table of FILLED_BY_USE) {
    const [row] = sql.exec<{ found: number }>(`SELECT EXISTS (SELECT 1 FROM "${table}") AS found`).toArray();
    if (row?.found) return `This kitshn is not empty: it has ${table}, so it takes no import (K-1833).`;
  }
  // The first start writes one revision of kitshn itself ("Set up kitshn"); any other means use.
  const [history] = sql
    .exec<{ count: number; others: number | null }>(
      "SELECT COUNT(*) AS count, SUM(json_extract(actor, '$._tag') != 'kitshn') AS others FROM revisions",
    )
    .toArray();
  if ((history?.count ?? 0) > 1 || (history?.others ?? 0) > 0)
    return "This kitshn is not empty: History has changes, so it takes no import (K-1833).";
  const cards = sql.exec<{ id: string }>("SELECT id FROM resources").toArray();
  const other = cards.find((card) => !firstStartCards.includes(card.id));
  return other
    ? `This kitshn is not empty: it has the card ${other.id}, so it takes no import (K-1833).`
    : null;
}

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/**
 * K-1833: drops every table, builds the schema of the export, writes its rows and runs the later migrations. The
 * caller runs it in one transaction and the code of later migrations (`after`) with it. Throws on a table or a
 * column that the schema of the export does not have, so the transaction rolls back.
 */
export function writeImport(sql: SqlStorage, state: StateExport, after: (from: number) => void) {
  const tables = sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    )
    .toArray()
    .map((row) => row.name);
  for (const name of tables) sql.exec(`DROP TABLE "${name}"`);
  sql.exec("DELETE FROM sqlite_sequence");
  sql.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  migrate((query) => sql.exec(query), 0, state.schemaVersion);
  const known = new Set(
    sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => row.name),
  );
  for (const [name, rows] of Object.entries(state.tables)) {
    if (!known.has(name))
      throw new Error(`The export has the table ${name}, which kitshn does not know (K-1833).`);
    // The export's own schema version comes back with its meta rows; the later migrations then move it on.
    if (name === "meta") sql.exec("DELETE FROM meta");
    for (const row of rows) {
      const columns = Object.keys(row);
      const values = columns.map((column) => {
        const value = row[column];
        return isRecord(value) && typeof value["base64"] === "string" ? fromBase64(value["base64"]) : value;
      });
      sql.exec(
        `INSERT INTO "${name}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        ...(values as Array<SqlStorageValue>),
      );
    }
  }
  migrate((query) => sql.exec(query), state.schemaVersion);
  after(state.schemaVersion);
}
