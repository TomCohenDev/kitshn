/**
 * The schema of the Durable Object as numbered migrations. Each list runs once, in order, in one
 * transaction with the new version number. Never change a migration that shipped; add a new one.
 */
export const MIGRATIONS: ReadonlyArray<ReadonlyArray<string>> = [
  // 1: the tables of milestones 1 to 3. They use IF NOT EXISTS, because databases from before the
  // migrations have them already.
  [
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS circles (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS resources (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS places (id TEXT PRIMARY KEY, x REAL NOT NULL, y REAL NOT NULL)",
    "CREATE TABLE IF NOT EXISTS share_settings (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    `CREATE TABLE IF NOT EXISTS revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
      actor TEXT NOT NULL, summary TEXT NOT NULL, changes TEXT NOT NULL, undoes INTEGER)`,
    "CREATE TABLE IF NOT EXISTS access_objects (key TEXT PRIMARY KEY, cf_id TEXT NOT NULL, body TEXT NOT NULL, tried TEXT NOT NULL, error TEXT)",
    "CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS presence (id TEXT PRIMARY KEY, online INTEGER NOT NULL, last_seen INTEGER NOT NULL)",
    `CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT, labels TEXT NOT NULL,
      command TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      actor TEXT NOT NULL, visitor TEXT NOT NULL, exit_code INTEGER, output TEXT NOT NULL)`,
    "CREATE INDEX IF NOT EXISTS jobs_state ON jobs (state, expires_at)",
    `CREATE TABLE IF NOT EXISTS join_codes (lookup TEXT PRIMARY KEY, machine_id TEXT NOT NULL, iv TEXT NOT NULL,
      sealed TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
    "CREATE TABLE IF NOT EXISTS tunnel_objects (machine_id TEXT PRIMARY KEY, body TEXT NOT NULL, error TEXT)",
    `CREATE TABLE IF NOT EXISTS live_sites (id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, name TEXT NOT NULL,
      address TEXT NOT NULL, target TEXT NOT NULL, dev INTEGER NOT NULL, up INTEGER NOT NULL, last_up INTEGER NOT NULL,
      state TEXT NOT NULL)`,
    "CREATE TABLE IF NOT EXISTS dns_objects (address TEXT PRIMARY KEY, record_id TEXT NOT NULL, content TEXT NOT NULL, error TEXT)",
    "CREATE TABLE IF NOT EXISTS route_objects (address TEXT PRIMARY KEY, route_id TEXT NOT NULL, error TEXT)",
    `CREATE TABLE IF NOT EXISTS deploys (id TEXT PRIMARY KEY, repo TEXT NOT NULL, environment TEXT NOT NULL,
      resource_id TEXT NOT NULL, address TEXT NOT NULL, script TEXT NOT NULL, starts_in TEXT, kind TEXT NOT NULL,
      sha TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL, branch TEXT NOT NULL DEFAULT '')`,
  ],
  // 2: the removal order of K-006. A tunnel row keeps the ingress that Cloudflare last accepted, and a
  // failed write waits five minutes, not a day, before the next try.
  [
    "ALTER TABLE tunnel_objects ADD COLUMN applied TEXT NOT NULL DEFAULT ''",
    "UPDATE tunnel_objects SET applied = body WHERE error IS NULL",
    "ALTER TABLE tunnel_objects ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE dns_objects ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE route_objects ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0",
  ],
  // 3: pages and files in R2 (sections 10 and 11). `source` names where an imported page came from, so
  // an import adds each page once (K-1008).
  [
    `CREATE TABLE library (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, file_name TEXT,
      thread TEXT, machine TEXT, size INTEGER NOT NULL, content_type TEXT NOT NULL, created_at INTEGER NOT NULL,
      source TEXT UNIQUE)`,
    "CREATE TABLE library_deleted (source TEXT PRIMARY KEY)",
  ],
  // 4: Compose deploys (K-812) run as a job on one machine.
  [
    "ALTER TABLE deploys ADD COLUMN app TEXT NOT NULL DEFAULT 'static'",
    "ALTER TABLE deploys ADD COLUMN machine_id TEXT",
    "ALTER TABLE deploys ADD COLUMN job_id INTEGER",
    "ALTER TABLE deploys ADD COLUMN compose_file TEXT",
  ],
  // 5: stacks that the owner makes (K-521).
  ["CREATE TABLE stacks (id TEXT PRIMARY KEY, body TEXT NOT NULL)"],
  // 6: the repo gate (K-819), by GitHub repository id. The Durable Object then fills `deploys.repo_id` of
  // older rows (backfillRepoIds), because the id comes out of the card id with code.
  [
    `CREATE TABLE repos (repo_id TEXT PRIMARY KEY, name TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('waiting', 'allowed', 'blocked')), first_seen INTEGER NOT NULL, branch TEXT)`,
    "ALTER TABLE deploys ADD COLUMN repo_id TEXT",
  ],
];

/** K-819: the migration after which the Durable Object derives the repo ids of older deploy rows. */
export const REPO_GATE_MIGRATION = 6;

/** Runs the migrations after `from`. Returns the new version. The caller provides the transaction. */
export function migrate(exec: (query: string) => void, from: number): number {
  if (from > MIGRATIONS.length) {
    throw new Error(
      `The database has schema version ${from}, newer than this kitshn (${MIGRATIONS.length}).`,
    );
  }
  for (let version = from + 1; version <= MIGRATIONS.length; version++) {
    for (const query of MIGRATIONS[version - 1] ?? []) exec(query);
    exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '${version}')`);
  }
  return MIGRATIONS.length;
}
