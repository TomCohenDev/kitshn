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
  // 7: the audience tag of each Access application, for the Access check on tunnel ingress (K-603).
  ["ALTER TABLE access_objects ADD COLUMN aud TEXT NOT NULL DEFAULT ''"],
  // 8: the agent key that allowed a repo (K-718, K-819); null when the owner allowed it.
  [
    "ALTER TABLE repos ADD COLUMN allowed_by_client TEXT",
    "ALTER TABLE repos ADD COLUMN allowed_by_name TEXT",
  ],
  // 9: the one-time codes of "Reset key" (K-1706). They hold no secret, unlike join codes.
  [
    "CREATE TABLE rekey_codes (lookup TEXT PRIMARY KEY, machine_id TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  ],
  // 10: the revision that a per-item undo reverses (K-1507); moves never join such an undo (K-1505).
  ["ALTER TABLE revisions ADD COLUMN item_undo INTEGER"],
  // 11: card icons. A static site keeps one small icon (K-1113); a machine keeps the system of its last status
  // (K-524), so its card keeps the icon while it is offline.
  [
    "CREATE TABLE icons (id TEXT PRIMARY KEY, type TEXT NOT NULL, hash TEXT NOT NULL, bytes BLOB NOT NULL)",
    "ALTER TABLE presence ADD COLUMN os TEXT",
  ],
  // 12: what GitHub said about each repo id (K-819): when kitshn last asked, and since when the repo is gone.
  ["ALTER TABLE repos ADD COLUMN checked_at INTEGER", "ALTER TABLE repos ADD COLUMN gone_at INTEGER"],
  // 13: when each icon last changed; a daemon changes the icon of a site at most once an hour (K-1114).
  ["ALTER TABLE icons ADD COLUMN changed_at INTEGER NOT NULL DEFAULT 0"],
  // 14: every address that serves an environment, the main one first, as JSON (K-817). Null on older rows means
  // the one address of the row.
  ["ALTER TABLE deploys ADD COLUMN addresses TEXT"],
  // 15: the card that made each DNS record (K-817); null on older rows, which then count as another card's.
  ["ALTER TABLE dns_objects ADD COLUMN card_id TEXT"],
  // 16: Worker apps (K-806). A deploy keeps the `worker` part of its recipe as JSON, so later steps use the planned
  // recipe. `worker_storage` holds the KV namespace of each binding (`kv`), and the script that "Remove app" kept
  // (`script`, with the script name as cf_id), so a removed app has a way to delete them (K-909).
  [
    "ALTER TABLE deploys ADD COLUMN worker TEXT",
    `CREATE TABLE worker_storage (card_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('kv', 'script')),
      name TEXT NOT NULL, cf_id TEXT NOT NULL, PRIMARY KEY (card_id, kind, name))`,
  ],
  // 17: several apps per repo (K-804) and their order (K-820). `app_key` is the app of the deploy; older rows are
  // the app `app`. `state` also takes 'failed' and 'skipped', with `reason`. `version_id` (the Cloudflare version of a
  // static or Worker deploy) and the run keep what a later rollback needs.
  [
    "ALTER TABLE deploys ADD COLUMN app_key TEXT NOT NULL DEFAULT 'app'",
    "ALTER TABLE deploys ADD COLUMN reason TEXT",
    "ALTER TABLE deploys ADD COLUMN version_id TEXT",
    "ALTER TABLE deploys ADD COLUMN run_id TEXT",
    "ALTER TABLE deploys ADD COLUMN run_attempt TEXT",
    // The card panel reads the newest deploy of each card (deployNotes), and deploy rows never go away.
    "CREATE INDEX deploys_resource ON deploys (resource_id)",
  ],
  // 18: rollback (K-821). `images` holds the image id of each service of a Compose deploy that came up; `needs` the
  // keys of `needs.apps`, so a run rolls back in its own order. `origin` is the deploy whose build a rollback row
  // repeats, the id that the daemon keeps it by. `rollbacks` holds the steps of a run rollback and the job it waits for.
  [
    "ALTER TABLE deploys ADD COLUMN images TEXT",
    "ALTER TABLE deploys ADD COLUMN needs TEXT",
    "ALTER TABLE deploys ADD COLUMN origin TEXT",
    `CREATE TABLE rollbacks (id TEXT PRIMARY KEY, steps TEXT NOT NULL, next INTEGER NOT NULL, state TEXT NOT NULL,
      actor TEXT NOT NULL, notes TEXT NOT NULL, job_id INTEGER)`,
  ],
  // 19: the workflow file of the run that waits at the repo gate, which Allow starts again, and of the run of each
  // deploy, which a restore from the trash and an agent key build start again (K-1121).
  ["ALTER TABLE repos ADD COLUMN workflow TEXT", "ALTER TABLE deploys ADD COLUMN workflow TEXT"],
  // 20: the badge reads the newest deploy of a repo by name in any case (K-1119); anyone can ask for any name.
  ["CREATE INDEX deploys_badge ON deploys (lower(repo), app_key, environment)"],
  // 21: agent uploads (K-1116, K-1117). `added_by` is the client id of the agent key that published a page or a file;
  // only that key updates it by name. R2 keeps two slots of an item (`slotKey`); `current_slot` names the one that
  // serves, with `size` and `content_type`. `previous_size` and `previous_type` describe the bytes of the other slot,
  // the one previous version, and are null when the item has none. `agent_tray` is 1 while a card has waited in the
  // tray since its key published it; the first move or share, or any change by the owner, sets it to 0.
  [
    "ALTER TABLE library ADD COLUMN added_by TEXT",
    "ALTER TABLE library ADD COLUMN current_slot INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE library ADD COLUMN agent_tray INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE library ADD COLUMN previous_size INTEGER",
    "ALTER TABLE library ADD COLUMN previous_type TEXT",
  ],
  // 22: address names of pages and files (K-1120). A row stays when its item gets a new name, so the old name sends
  // visitors on and no other item takes it; the delete of the item removes its rows.
  [
    "CREATE TABLE library_addresses (kind TEXT NOT NULL, name TEXT NOT NULL, item_id TEXT NOT NULL, PRIMARY KEY (kind, name))",
    "CREATE INDEX library_addresses_item ON library_addresses (item_id)",
  ],
  // 23: folder sites (K-1123), a static site that an agent key publishes from a folder, with no repo. `circle` and
  // `public` are where the first publish lands; `agent_tray` works as for pages (K-1117).
  [
    `CREATE TABLE agent_sites (card_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, folder TEXT NOT NULL,
     address TEXT NOT NULL, circle TEXT, public INTEGER NOT NULL DEFAULT 0, agent_tray INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
     UNIQUE (client_id, folder))`,
  ],
  // 24: old site addresses (K-817, K-1124). Each one sends its visitors on to the main address of its card through the
  // kitshn-redirects Worker; the rowid orders them, and a card keeps its 5 newest (K-1122).
  // `attached` is 1 while the custom domain is on the redirect Worker, so its Access application stays until it goes.
  [
    "CREATE TABLE old_addresses (address TEXT PRIMARY KEY, card_id TEXT NOT NULL, attached INTEGER NOT NULL DEFAULT 0)",
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
