// K-1833: rebuilds the state of an empty install from a state export of K-1831.
import type { StateExport } from "./backups.ts";
import { MIGRATIONS, migrate } from "./migrations.ts";

/** K-1833: the tables that make an install not empty; the first start fills none of them. */
const FILLED_BY_USE = ["machines", "deploys", "library", "repos"] as const;

/** K-1833: the reason codes that the public import status may name; the details stay in the server log. */
export type ImportCode =
  "no_file" | "bad_file" | "other_account" | "newer_schema" | "unknown_table" | "not_empty" | "failed";

export interface ImportRefusal {
  readonly code: ImportCode;
  /** For the server log only; it can name an account, a card or a table. */
  readonly detail: string;
}

/** A refusal that a step inside the import transaction throws, so the transaction rolls back. */
export class ImportError extends Error {
  constructor(
    readonly code: ImportCode,
    message: string,
  ) {
    super(message);
  }
}

const refusal = (code: ImportCode, detail: string): ImportRefusal => ({ code, detail });

/** The object that the import starts the bootstrap with: `import/state.json.gz` in the bucket. */
export const IMPORT_OBJECT = "import/state.json.gz";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A table or column name of the export; it goes into SQL, so only plain names pass. */
const plainName = (name: string) => /^[a-z_][a-z0-9_]*$/.test(name);

/** K-1833: the export, or why kitshn refuses it. */
export function readExport(value: unknown, account: string): StateExport | ImportRefusal {
  if (!isRecord(value) || value["format"] !== "kitshn-state" || value["version"] !== 1)
    return refusal("bad_file", "The file is no kitshn state export (K-1831).");
  const { schemaVersion, exportedAt, tables } = value;
  if (typeof value["account"] !== "string")
    return refusal("other_account", "The export names no Cloudflare account (K-1833).");
  if (value["account"] !== account)
    return refusal(
      "other_account",
      `The export is of the Cloudflare account ${value["account"]}, not ${account} (K-1834).`,
    );
  if (typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1)
    return refusal("bad_file", "The export names no schema version.");
  if (schemaVersion > MIGRATIONS.length)
    return refusal(
      "newer_schema",
      `The export has schema version ${schemaVersion}, newer than ${MIGRATIONS.length}.`,
    );
  if (typeof exportedAt !== "number" || !isRecord(tables))
    return refusal("bad_file", "The export has no time or no tables.");
  for (const [name, rows] of Object.entries(tables)) {
    if (!plainName(name) || !Array.isArray(rows) || !rows.every(isRecord))
      return refusal("bad_file", `The table ${name} of the export is not a list of rows.`);
    for (const row of rows)
      for (const column of Object.keys(row))
        if (!plainName(column))
          return refusal("bad_file", `The column ${column} of ${name} is not a plain name.`);
  }
  return value as unknown as StateExport;
}

/** K-1833: why this install is not empty, or null. Only the cards of the first start may exist. */
export function notEmptyReason(
  sql: SqlStorage,
  firstStartCards: ReadonlyArray<string>,
): ImportRefusal | null {
  for (const table of FILLED_BY_USE) {
    const [row] = sql.exec<{ found: number }>(`SELECT EXISTS (SELECT 1 FROM "${table}") AS found`).toArray();
    if (row?.found) return refusal("not_empty", `This kitshn is not empty: it has ${table}.`);
  }
  // The first start writes one revision of kitshn itself ("Set up kitshn"); any other means use.
  const [history] = sql
    .exec<{ count: number; others: number | null }>(
      "SELECT COUNT(*) AS count, SUM(json_extract(actor, '$._tag') != 'kitshn') AS others FROM revisions",
    )
    .toArray();
  if ((history?.count ?? 0) > 1 || (history?.others ?? 0) > 0)
    return refusal("not_empty", "This kitshn is not empty: History has changes.");
  const cards = sql.exec<{ id: string }>("SELECT id FROM resources").toArray();
  const other = cards.find((card) => !firstStartCards.includes(card.id));
  return other ? refusal("not_empty", `This kitshn is not empty: it has the card ${other.id}.`) : null;
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
      throw new ImportError("unknown_table", `The export has the table ${name}, which kitshn does not know.`);
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
