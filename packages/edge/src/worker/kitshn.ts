import { ICON_LIMIT, iconType, pageDataIcon } from "kitshn/icon";
import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";
import { ACCESS_NAME_PREFIX, ENROLLMENT_KEY, desiredAccess } from "../core/access.ts";
import { appRestart, appTeardown, composeUndo, orphanVolumes } from "../core/apps.ts";
import {
  type Actor,
  type AppCard,
  type Change,
  type Edit,
  type Forget,
  RuleError,
  applyChanges,
  conflictOf,
  deepEqual,
  invert,
  type Item,
  mergeMoves,
  mergedSummary,
  type StoredRevision,
  undoAnswer,
  prepareUndo,
  undoTarget,
  refuseRaiseWhilePaused,
  refuseResume,
  removeAppChanges,
  resolveEdits,
  restoredResource,
  revisionTargets,
  type RevisionTarget,
  targetOf,
  ruleViolation,
  stacksWithout,
  summarize,
} from "../core/changes.ts";
import {
  ADMIN_RESOURCE_ID,
  AGENT_RIGHTS,
  type Circle,
  type Member,
  type Point,
  type Resource,
  type ShareSetting,
  pauseModeOf,
  type Stack,
  type State,
  circlesHolding,
} from "../core/model.ts";
import {
  type Command,
  type DaemonMessage,
  type Machine,
  type MachineKey,
  type MachineStatus,
  type ProjectVolume,
  type Sample,
  type ServerToDaemon,
  allowedFor,
  connectText,
  fingerprintOf,
  parseAllowances,
  parsePublicKey,
  joinLookup,
  newChallenge,
  newJoinCode,
  rotateText,
  sealJoin,
  verifyText,
} from "../core/machine.ts";
import { placeInside } from "../core/place.ts";
import type {
  DeployNote,
  MachineView,
  OrphanWorker,
  RepoView,
  RevisionView,
  ServerMessage,
  Snapshot,
} from "../core/protocol.ts";
import {
  type AllowingAgent,
  type RepoGate,
  type RepoState,
  agentAllowRefusal,
  forgetRefusal,
  gateDecision,
  keyRemoved,
} from "../core/repos.ts";
import { ClientMessage } from "../core/schema.ts";
import {
  type LastDeploy,
  agentDeployPlan,
  agentHas,
  agentHomeCircle,
  agentMayRunOn,
  agentRefusal,
  cardsControlledBy,
  circlesOf,
  isEveryoneCircle,
  isPreview,
  mayDeployOn,
  publishPlace,
} from "../core/agent.ts";
import { DEMO_MACHINES, DEMO_ICONS, demo } from "../core/demo.ts";
import { type MachineOs, machineOs } from "../core/icons.ts";
import {
  contentSecurityPolicy,
  type ContentVisitor,
  type LibraryItem,
  MAX_UPLOAD_BYTES,
  contentAccess,
  fileNameError,
  newLibraryId,
  objectKey,
} from "../core/library.ts";
import { badgeState } from "../core/badge.ts";
import { listedApps } from "../core/listing.ts";
import { seed } from "../core/seed.ts";
import { type Visitor, visitorLevel } from "../core/visitor.ts";
import {
  type AccessRow,
  type AccessStore,
  type Api,
  accessStates,
  CALLS_PER_RUN,
  fillAudiences,
  hasAccessWork,
  rowsWithoutAud,
  type SignOutOutcome,
  readSignOutLeft,
  retryApps,
  revokeSessions,
  sessionApps,
  signOutSummary,
  signOutWarning,
  syncAccess,
  syncLauncher,
  LOGIN_CALLS,
  loginHeld,
  loginHeldAfter,
  loginWant,
  loginWarnings,
  syncLogins,
  syncWithLogins,
  verifyAccess,
  verifyPasskeys,
} from "./access-sync.ts";
import type { Caller, Deployer } from "./auth.ts";
import { CloudflareError, cloudflare } from "./cloudflare.ts";
import { type RepoOnGitHub, dispatchDeploy, reposOnGitHub } from "./github.ts";
import { REPLACED, dropLiveSite, failQueuedDowns, removalDown, requeueDowns } from "./downs.ts";
import { REPO_GATE_MIGRATION, migrate } from "./migrations.ts";
import {
  DEPLOY_MS,
  SCRIPT_LIMIT,
  STATIC_WORKER,
  jobError,
  keptImages,
  parseWorkerModule,
  parseWorkerSecrets,
  workerMetadata,
  environmentNames,
  eventOf,
  legacyRepos,
  parseManifest,
  parseConfigFile,
  parseSiteIcon,
} from "./deploys.ts";
import { DEFAULT_APP } from "kitshn/names";
import { AppKey, type Recipe, WorkerApp, decodeRecipe, deployOrder, plan, repoSlug } from "kitshn/recipe";
import { type Zone, removeStaleDomains, zoneFor, zoneOfAddressIn, zonesOf } from "./zones.ts";
import {
  type LiveSite,
  ingressAccess,
  liveSiteId,
  reachableAddresses,
  offlineReason,
  parseSites,
  addressRecords,
  dnsRecordRefusal,
  nextCardAddresses,
  protectedLiveSites,
  servedSites,
  sitesNeedingRoutes,
  tunnelConfig,
} from "./live.ts";
import {
  JOB_EXPIRY_MS,
  JOIN_CODE_MS,
  type Job,
  OUTPUT_LIMIT,
  PING_TIMEOUT_MS,
  machineIdFor,
  parseCommand,
  parseLabels,
  legacyUpdateScript,
  type MachineCheck,
  answerCheck,
  pickMachine,
  rekeyDecision,
  socketStart,
} from "./machines.ts";
import type { Env } from "./env.ts";

/** What a WebSocket of this Durable Object belongs to. */
type Attachment =
  | { readonly kind: "map"; readonly caller: Caller }
  | {
      readonly kind: "machine";
      readonly machineId: string;
      readonly since: number;
      /** K-1704: the challenge of this socket. A rotation on it signs it too (K-1705). */
      readonly challenge: string;
      readonly check: MachineCheck;
      /** K-1704: each socket takes one answer only. */
      readonly answered: boolean;
      /** K-1705: who pressed "Rotate key" in the panel; History names them. */
      readonly rotateBy: Actor | null;
      /** K-605, K-606: kept on the socket, so they survive hibernation and cost no row writes. */
      readonly status: MachineStatus | null;
      readonly sample: Sample | null;
      /** K-909: the idle volumes of kitshn apps; a socket from before this field has none. */
      readonly volumes?: ReadonlyArray<ProjectVolume>;
    };

/** The attachment of a socket; null for one that never got one, which every reader skips. */
const attachmentOf = (socket: WebSocket) => socket.deserializeAttachment() as Attachment | null;

/** K-1704 */
const CHALLENGE_MS = 10_000;
/** K-1705 */
const ROTATED = 4004;
/** K-1706 */
const KEY_RESET = 4005;

/** K-110: a sign-out or retry that started longer ago than this no longer blocks a new one (a lost run). */
const SIGN_OUT_RUN_MS = 3 * 60_000;
/** The map keeps this many recent revisions in memory; History reads them (K-519). */
const RECENT_REVISIONS = 200;
/** K-1503 */
const REVISION_DAYS = 90;
const REVISION_COUNT = 5000;
const DAY = 24 * 60 * 60 * 1000;

const nextUtcMidnight = (now: number) => Math.floor(now / DAY) * DAY + DAY;

const decodeClientMessage = Schema.decodeUnknownSync(ClientMessage);

/** K-1502, K-1507: the revision that an undo reverses; `item` names the card or circle of a per-item undo. */
interface UndoOf {
  readonly revision: number;
  readonly item: string | null;
}

/** The POST paths that take a client message as their body. */
const API_MESSAGES: Readonly<Record<string, ClientMessage["type"]>> = {
  "/api/apply": "apply",
  "/api/undo": "undo",
  "/api/undo-item": "undoItem",
};

/** K-003: the one Durable Object. It holds all state in SQLite and a copy in memory. */
export class Kitshn extends DurableObject<Env> {
  private state!: State;
  private revisions: Array<RevisionView> = [];
  /**
   * K-909: the cards whose orphaned Worker storage kitshn deletes now; their deploys and Undo wait. Known limit: it
   * lives in memory. A restart in the middle of a delete ends the delete with no History entry for the part that went,
   * and can leave a KV row whose namespace Cloudflare already deleted; the storage step of the next deploy finds such a
   * row and makes the namespace again. Revisit when a delete must survive a restart, for example with a row per delete.
   */
  private readonly deletingStorage = new Set<string>();
  private access = new Map<string, AccessRow>();
  /** Expired shares whose card has no place outside the circle. Retried once after each restart. */
  private stuckShares = new Set<string>();
  private accessWarnings: Array<string> = [];
  /** K-819: a GitHub check of the repos runs, so a second open tab starts none. */
  private checkingRepos = false;
  /** K-606: presence is stored on change; status and the latest sample live on the socket. */
  private presence = new Map<string, { online: boolean; lastSeen: number; os: MachineOs | null }>();
  /** K-1113: the hash of each stored card icon; the bytes stay in SQLite until a map asks. */
  private iconHashes = new Map<string, string>();
  /** K-1114: when each stored icon last changed, so a daemon changes one at most once an hour. */
  private iconChangedAt = new Map<string, number>();
  /** K-1104: live sites of the machines. */
  private liveSites = new Map<string, LiveSite>();
  /** Address checks that failed, and when to try them again. Memory only; a restart retries at once. */
  private checkRetryAt = new Map<string, number>();
  /** K-1708: the last failed challenge of each machine, for the panel. Memory only (K-1302). */
  private keyFailures = new Map<string, { readonly at: number; readonly reason: string }>();

  private meta(key: string): string | null {
    const [row] = this.sql<{ value: string }>("SELECT value FROM meta WHERE key = ?", key);
    return row?.value ?? null;
  }

  /** Writes a meta value only when it changes (K-1302). */
  private setMeta(key: string, value: string) {
    if (this.meta(key) !== value)
      this.sql("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // K-604: a daemon ping never wakes the Durable Object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    void ctx.blockConcurrencyWhile(async () => {
      // Numbered migrations: each runs once per database, with its version, in one transaction.
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const [version] = ctx.storage.sql
        .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
        .toArray();
      const from = Number(version?.value ?? 0);
      ctx.storage.transactionSync(() => {
        migrate((query) => ctx.storage.sql.exec(query), from);
        // The rest of migration 6 needs code: the repo id comes out of each card id.
        if (from < REPO_GATE_MIGRATION) this.backfillRepoIds();
      });
      this.load();
      if (this.state.circles.size === 0) this.seed();
      this.syncAdminAddress();
      this.reconcilePresence();
      // K-821: a restart cut off any run rollback that did not wait for a job.
      this.settleRollbacks();
      await this.scheduleAlarm();
    });
  }

  private sql<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: Array<SqlStorageValue>) {
    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
  }

  /** The SQL of the job helpers in downs.ts, which tests run on node:sqlite. */
  private query = (query: string, ...bindings: Array<string | number | null>) => this.sql(query, ...bindings);

  private load() {
    const json = <T>(rows: Array<{ id: string; body: string }>) =>
      new Map(rows.map((row) => [row.id, JSON.parse(row.body) as T]));
    this.state = {
      circles: json<Circle>(this.sql("SELECT id, body FROM circles")),
      resources: json<Resource>(this.sql("SELECT id, body FROM resources")),
      places: new Map(
        this.sql<{ id: string; x: number; y: number }>("SELECT id, x, y FROM places").map((row) => [
          row.id,
          { x: row.x, y: row.y },
        ]),
      ),
      shareSettings: json<ShareSetting>(this.sql("SELECT id, body FROM share_settings")),
      stacks: json<Stack>(this.sql("SELECT id, body FROM stacks")),
      paused: pauseModeOf(this.meta("paused")),
      machines: json<Machine>(this.sql("SELECT id, body FROM machines")),
    };
    this.liveSites = new Map(
      this.sql<{
        id: string;
        machine_id: string;
        name: string;
        address: string;
        target: string;
        dev: number;
        up: number;
        last_up: number;
        state: LiveSite["state"];
      }>("SELECT * FROM live_sites").map((row) => [
        row.id,
        {
          id: row.id,
          machineId: row.machine_id,
          name: row.name,
          address: row.address,
          target: row.target,
          dev: row.dev === 1,
          up: row.up === 1,
          lastUp: row.last_up,
          state: row.state,
        },
      ]),
    );
    this.presence = new Map(
      this.sql<{ id: string; online: number; last_seen: number; os: string | null }>(
        "SELECT id, online, last_seen, os FROM presence",
      ).map((row) => [
        row.id,
        // Only setMachineOs writes `os`, with a MachineOs.
        { online: row.online === 1, lastSeen: row.last_seen, os: row.os as MachineOs | null },
      ]),
    );
    const icons = this.sql<{ id: string; hash: string; changed_at: number }>(
      "SELECT id, hash, changed_at FROM icons",
    );
    this.iconHashes = new Map(icons.map((row) => [row.id, row.hash]));
    this.iconChangedAt = new Map(icons.map((row) => [row.id, row.changed_at]));
    this.accessWarnings = JSON.parse(this.meta("access_warnings") ?? "[]") as Array<string>;
    this.access = new Map(
      this.sql<{
        key: string;
        cf_id: string;
        aud: string;
        body: string;
        tried: string;
        error: string | null;
      }>("SELECT key, cf_id, aud, body, tried, error FROM access_objects").map((row) => [
        row.key,
        { key: row.key, cfId: row.cf_id, aud: row.aud, body: row.body, tried: row.tried, error: row.error },
      ]),
    );
    const rows = this.sql<{
      id: number;
      at: number;
      actor: string;
      summary: string;
      undoes: number | null;
      empty: number;
      targets: string;
    }>(
      // K-1508: only the tag, id and stack members of each change, so the load never parses whole circles.
      `SELECT id, at, actor, summary, undoes,
         NOT EXISTS (SELECT 1 FROM json_each(changes) WHERE json_extract(value, '$._tag') != 'forget') AS empty,
         (SELECT json_group_array(json_object('_tag', json_extract(value, '$._tag'), 'id', json_extract(value, '$.id'),
             'members', CASE WHEN json_extract(value, '$._tag') = 'stack'
               THEN json_array(json_extract(value, '$.before.members'), json_extract(value, '$.after.members')) END))
           FROM json_each(changes)) AS targets
       FROM revisions ORDER BY id DESC LIMIT ?`,
      RECENT_REVISIONS,
    );
    const undone = new Map(
      this.sql<{ id: number; undoes: number }>(
        "SELECT id, undoes FROM revisions WHERE undoes IS NOT NULL ORDER BY id DESC LIMIT ?",
        RECENT_REVISIONS,
      ).map((row) => [row.undoes, row.id]),
    );
    this.revisions = rows.map((row) => ({
      id: row.id,
      at: row.at,
      actor: JSON.parse(row.actor) as Actor,
      summary: row.summary,
      undoes: row.undoes,
      undoneBy: undone.get(row.id) ?? null,
      undoable: row.empty === 0,
      ...revisionTargets(JSON.parse(row.targets) as Array<RevisionTarget>),
    }));
  }

  private seed() {
    const emails = this.env.OWNER_EMAILS.split(",")
      .map((email) => email.trim())
      .filter(Boolean);
    if (emails.length === 0) throw new Error("OWNER_EMAILS is empty: kitshn cannot make the Owner circle.");
    const initial = seed(emails, this.env.KITSHN_HOST, ownerDevices(this.env.OWNER_DEVICES));
    const extra =
      this.env.DEV_DEMO && this.env.KITSHN_HOST === "localhost"
        ? demo()
        : { resources: [], places: [], circles: [] };
    this.ctx.storage.transactionSync(() => {
      for (const resource of [...initial.resources, ...extra.resources]) this.putResource(resource);
      const changes: Array<Change> = [
        ...[...initial.circles, ...extra.circles].map((circle): Change => ({
          _tag: "circle",
          id: circle.id,
          before: null,
          after: circle,
        })),
        ...[...initial.places, ...extra.places].map(([id, point]): Change => ({
          _tag: "place",
          id,
          before: null,
          after: point,
        })),
      ];
      this.persist(changes);
      // The local demo shows the repo gate (K-819): one repo that deploys, one that waits, and two that GitHub
      // deleted, one of them allowed by an agent key that the owner removed.
      if (extra.resources.length > 0)
        for (const [id, name, state, key, goneAt] of [
          ["1001", "Yarden-zamir/riffle", "allowed", null, null],
          ["1002", "Yarden-zamir/new-app", "waiting", null, null],
          ["1003", "Yarden-zamir/kitshn-hello", "allowed", null, Date.now()],
          ["1004", "Yarden-zamir/kitshn-agent-e2e", "allowed", "demo-removed-key", Date.now()],
        ] as const)
          this.sql(
            `INSERT OR IGNORE INTO repos (repo_id, name, state, first_seen, allowed_by_client, allowed_by_name, gone_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            id,
            name,
            state,
            Date.now(),
            key,
            key === null ? null : "Yarden's agents",
            goneAt,
          );
      // K-524, K-1113, K-1114: the demo cards show site icons and the system of each machine.
      if (extra.resources.length > 0) {
        for (const icon of DEMO_ICONS)
          this.sql(
            "INSERT OR IGNORE INTO icons (id, type, hash, bytes) VALUES (?, ?, 'demo', ?)",
            icon.id,
            icon.type,
            new TextEncoder().encode(icon.svg).slice().buffer,
          );
        for (const { machine, os } of DEMO_MACHINES) {
          this.sql(
            "INSERT OR IGNORE INTO machines (id, body) VALUES (?, ?)",
            machine.id,
            JSON.stringify(machine),
          );
          this.sql(
            "INSERT OR IGNORE INTO presence (id, online, last_seen, os) VALUES (?, 0, ?, ?)",
            machine.id,
            Date.now() - 3_600_000,
            os,
          );
        }
      }
      // The demo's riffle card counts as deployed, so the card panel shows "Remove app" (K-909).
      if (extra.resources.some((resource) => resource.id === "riffle"))
        this.sql(
          `INSERT OR IGNORE INTO deploys (id, repo, repo_id, environment, resource_id, address, script, starts_in, kind, sha, state, expires_at, branch, app, machine_id, compose_file)
           VALUES ('demo-riffle', 'Yarden-zamir/riffle', '1001', 'prod', 'riffle', 'riffle.example.com', '', NULL, 'deploy', 'demo', 'done', 0, 'main', 'compose', NULL, NULL)`,
        );
      this.insertRevision({ _tag: "kitshn", reason: "setup" }, "Set up kitshn", changes, null);
    });
    this.load();
  }

  /** The admin card follows the host that the bootstrap set (K-1208). */
  private syncAdminAddress() {
    const admin = this.state.resources.get(ADMIN_RESOURCE_ID);
    if (!admin || (admin.addresses.length === 1 && admin.addresses[0] === this.env.KITSHN_HOST)) return;
    const updated: Resource = { ...admin, addresses: [this.env.KITSHN_HOST] };
    this.putResource(updated);
    this.state = { ...this.state, resources: new Map(this.state.resources).set(updated.id, updated) };
  }

  private putResource(resource: Resource) {
    this.sql(
      "INSERT OR REPLACE INTO resources (id, body) VALUES (?, ?)",
      resource.id,
      JSON.stringify(resource),
    );
  }

  private persist(changes: ReadonlyArray<Change>) {
    for (const change of changes) {
      if (change._tag === "pause") {
        this.setMeta("paused", change.after ?? "");
        continue;
      }
      if (change._tag === "app") {
        if (change.after) this.putResource(restoredResource(change.after));
        else this.sql("DELETE FROM resources WHERE id = ?", change.id);
        continue;
      }
      const table =
        change._tag === "circle"
          ? "circles"
          : change._tag === "place"
            ? "places"
            : change._tag === "stack"
              ? "stacks"
              : "share_settings";
      if (change.after === null) this.sql(`DELETE FROM ${table} WHERE id = ?`, change.id);
      else if (change._tag === "place") {
        this.sql(
          "INSERT OR REPLACE INTO places (id, x, y) VALUES (?, ?, ?)",
          change.id,
          change.after.x,
          change.after.y,
        );
      } else
        this.sql(
          `INSERT OR REPLACE INTO ${table} (id, body) VALUES (?, ?)`,
          change.id,
          JSON.stringify(change.after),
        );
    }
  }

  /** The newest revision id ever made. It never goes down, also after the cleanup of K-1503. */
  private lastRevision(): number {
    const [row] = this.sql<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'revisions'");
    return row?.seq ?? 0;
  }

  private insertRevision(
    actor: Actor,
    summary: string,
    changes: ReadonlyArray<Change | Forget>,
    undoes: number | null,
    itemUndo: number | null = null,
  ) {
    const [row] = this.sql<{ id: number }>(
      "INSERT INTO revisions (at, actor, summary, changes, undoes, item_undo) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
      Date.now(),
      JSON.stringify(actor),
      summary,
      JSON.stringify(changes),
      undoes,
      itemUndo,
    );
    if (!row) throw new Error("The revision insert returned no id.");
    return row.id;
  }

  /** K-401, K-909: the Access objects, with the addresses that removed apps still serve. */
  private desired(now: number) {
    const removed = [...this.liveSites.values()].filter(
      (site) => site.state === "ok" && !this.state.resources.has(site.id),
    );
    return desiredAccess(this.state, now, removed);
  }

  /** The rules that every write keeps (K-105, K-1504). Returns the state after the changes. */
  private checked(changes: ReadonlyArray<Change>): State {
    const after = applyChanges(this.state, changes);
    const violation = ruleViolation(after);
    if (violation) throw new RuleError(violation);
    refuseRaiseWhilePaused(this.state, after);
    return after;
  }

  /**
   * One write: checks the rules (K-105), stores the changes and one revision (K-1501), then tells everyone.
   * Moves that follow a move or drop of the same actor join its revision (K-1505).
   */
  private commit(actor: Actor, changes: ReadonlyArray<Change>, undo: UndoOf | null): number | null {
    if (changes.length === 0) return null;
    const before = this.state;
    const after = this.checked(changes);
    const now = Date.now();
    const merge = undo === null ? this.movesToMerge(actor, now, changes) : null;
    const label =
      undo === null
        ? ""
        : undo.item === null
          ? `Undo #${undo.revision}: `
          : `Undo #${undo.revision} for ${undo.item}: `;
    const summary = merge
      ? mergedSummary(
          merge.summary,
          applyChanges(before, invert(merge.previous)),
          before,
          after,
          merge.changes,
        )
      : label + summarize(before, after, changes);
    // A per-item undo is a change of its own (K-1507); only a whole undo marks its revision as undone.
    const undoes = undo?.item === null ? undo.revision : null;
    const id = this.ctx.storage.transactionSync(() => {
      this.persist(changes);
      // A switch to a lockdown keeps who paused first and when.
      if (changes.some((change) => change._tag === "pause" && change.after && !change.before)) {
        this.setMeta("paused_by", JSON.stringify(actor));
        this.setMeta("paused_at", String(Date.now()));
        // K-1504: jobs that devices and agent keys queued do not run after Resume.
        this.sql(
          `UPDATE jobs SET state = 'failed', output = 'The emergency pause ended this job.'
           WHERE state = 'queued' AND json_extract(visitor, '$.email') IS NULL AND json_extract(visitor, '$.clientId') IS NOT NULL`,
        );
      }
      if (merge) {
        this.sql(
          "UPDATE revisions SET at = ?, summary = ?, changes = ? WHERE id = ?",
          now,
          summary,
          JSON.stringify(merge.changes),
          merge.id,
        );
        return merge.id;
      }
      return this.insertRevision(actor, summary, changes, undoes, undo?.item ? undo.revision : null);
    });
    this.state = after;
    for (const change of changes) {
      if (change._tag === "shareSetting") this.stuckShares.delete(change.id);
      if (change._tag === "place")
        for (const id of this.stuckShares) if (id.startsWith(`${change.id}/`)) this.stuckShares.delete(id);
    }
    if (merge) {
      const targets = revisionTargets(merge.changes.map(targetOf));
      this.revisions = this.revisions.map((revision) =>
        revision.id === id ? { ...revision, at: now, summary, ...targets } : revision,
      );
      this.broadcast();
    } else
      this.showRevision({
        id,
        at: now,
        actor,
        summary,
        undoes,
        undoneBy: null,
        undoable: true,
        ...revisionTargets(changes.map(targetOf)),
      });
    void this.scheduleAlarm();
    return id;
  }

  /** K-1505: the newest revision with these moves merged in, when they join it. */
  private movesToMerge(actor: Actor, now: number, changes: ReadonlyArray<Change>) {
    const [row] = this.sql<{
      id: number;
      at: number;
      actor: string;
      summary: string;
      changes: string;
      undoes: number | null;
      item_undo: number | null;
    }>("SELECT id, at, actor, summary, changes, undoes, item_undo FROM revisions ORDER BY id DESC LIMIT 1");
    // A per-item undo keeps `undoes` null (K-1507), and moves never join an undo.
    if (!row || row.item_undo !== null) return null;
    const previous = JSON.parse(row.changes) as Array<Change>;
    const merged = mergeMoves(
      { actor: JSON.parse(row.actor) as Actor, at: row.at, changes: previous, undoes: row.undoes },
      actor,
      now,
      changes,
    );
    return merged && { id: row.id, summary: row.summary, previous, changes: merged };
  }

  private apply(actor: Actor, edits: ReadonlyArray<Edit>) {
    return this.commit(actor, refuseResume(resolveEdits(this.state, edits)), null);
  }

  /** K-1504: "Resume", after the Worker checked a passkey login of at most ten minutes. */
  private resume(caller: Caller) {
    if (!this.authorized(caller))
      return Response.json(
        { error: "You have no control level on the kitshn admin (K-104)." },
        { status: 403 },
      );
    if (!this.state.paused) return Response.json({ revision: null });
    try {
      return Response.json({
        revision: this.commit(caller.actor, resolveEdits(this.state, [{ _tag: "pause", after: null }]), null),
      });
    } catch (error) {
      if (error instanceof RuleError) return Response.json({ error: error.message }, { status: 409 });
      throw error;
    }
  }

  /** K-1502, K-1506: Undo reverses the caller's own newest revision, and runs the same rules as an edit. */
  private undo(actor: Actor, revisionId: number) {
    const target = undoTarget(this.state, this.storedRevisions(), actor, { revision: revisionId });
    return this.commitUndo(actor, target.changes, { revision: target.revision, item: null });
  }

  /** K-1507: undoes the caller's own newest change to one card or circle, and only that item's part of it. */
  private undoItem(actor: Actor, item: Item) {
    const target = undoTarget(this.state, this.storedRevisions(), actor, { item });
    const name =
      item.kind === "card"
        ? (this.state.resources.get(item.id)?.name ?? item.id)
        : `the circle ${this.state.circles.get(item.id)?.name ?? item.id}`;
    return this.commitUndo(actor, target.changes, { revision: target.revision, item: name });
  }

  /** Every revision that History keeps (K-1503: at most 5,000). */
  private storedRevisions(): Array<StoredRevision> {
    return this.sql<{ id: number; actor: string; summary: string; changes: string; undoes: number | null }>(
      "SELECT id, actor, summary, changes, undoes FROM revisions",
    ).map((row) => ({
      id: row.id,
      actor: JSON.parse(row.actor) as Actor,
      summary: row.summary,
      changes: JSON.parse(row.changes) as Array<Change>,
      undoes: row.undoes,
    }));
  }

  private commitUndo(actor: Actor, original: ReadonlyArray<Change>, undo: UndoOf) {
    return this.commitApps(actor, prepareUndo(this.state, original), undo);
  }

  /** K-909: the Worker storage whose card is gone: a script that "Remove app" kept, and KV namespaces. */
  private orphanWorkers(): Array<OrphanWorker> {
    const byCard = new Map<string, { script: string | null; kv: Array<string> }>();
    for (const row of this.sql<{ card_id: string; kind: string; name: string; cf_id: string }>(
      "SELECT card_id, kind, name, cf_id FROM worker_storage ORDER BY card_id, name",
    )) {
      if (this.state.resources.has(row.card_id)) continue;
      const entry = byCard.get(row.card_id) ?? { script: null, kv: [] };
      if (row.kind === "script") entry.script = row.cf_id;
      else entry.kv.push(row.name);
      byCard.set(row.card_id, entry);
    }
    return [...byCard].map(([card, entry]) => ({ card, ...entry }));
  }

  /** K-909: a deploy of this card that has not ended yet. */
  private deployRuns(card: string) {
    return (
      this.sql<{ id: string }>(
        "SELECT id FROM deploys WHERE resource_id = ? AND state IN ('planned', 'running') AND expires_at > ? LIMIT 1",
        card,
        Date.now(),
      ).length > 0
    );
  }

  /**
   * K-909: deletes the orphaned Worker storage of a removed card: its kept script, and with it its Durable Objects,
   * and its KV namespaces. It refuses while a deploy of the card runs, and a deploy or an Undo of the card waits for
   * it (`deletingStorage`). Before each Cloudflare call it checks again that the card is gone and no deploy runs, and
   * stops otherwise. History records what went, also when a call failed; Undo cannot bring the data back.
   */
  private async deleteOrphanWorker(caller: Caller, card: string) {
    const orphan = this.orphanWorkers().find((item) => item.card === card);
    if (!orphan)
      return Response.json(
        { error: `${card} has no orphaned Worker storage; its card may be back on the map (K-909).` },
        { status: 409 },
      );
    if (this.deployRuns(card) || this.deletingStorage.has(card))
      return Response.json(
        {
          error: `A deploy of ${card}, or a delete of its storage, runs now. Try again after it ends (K-909).`,
        },
        { status: 409 },
      );
    const api = this.api();
    if (!api) return Response.json({ error: "kitshn has no Cloudflare API token here." }, { status: 503 });
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    const gone = (error: unknown) =>
      error instanceof CloudflareError && error.status === 404 ? undefined : Promise.reject(error);
    const steps: Array<{ readonly what: string; readonly run: () => Promise<void> }> = [
      ...(orphan.script
        ? [
            {
              what: `the Worker ${orphan.script} with its Durable Objects`,
              run: async () => {
                await api("DELETE", `${account}/workers/scripts/${orphan.script}?force=true`).catch(gone);
                this.sql("DELETE FROM worker_storage WHERE card_id = ? AND kind = 'script'", card);
              },
            },
          ]
        : []),
      ...this.sql<{ name: string; cf_id: string }>(
        "SELECT name, cf_id FROM worker_storage WHERE card_id = ? AND kind = 'kv'",
        card,
      ).map(({ name, cf_id }) => ({
        what: `the KV ${name}`,
        run: async () => {
          await api("DELETE", `${account}/storage/kv/namespaces/${cf_id}`).catch(gone);
          this.sql("DELETE FROM worker_storage WHERE card_id = ? AND kind = 'kv' AND name = ?", card, name);
        },
      })),
    ];
    const deleted: Array<string> = [];
    let problem: string | null = null;
    this.deletingStorage.add(card);
    try {
      for (const step of steps) {
        if (this.state.resources.has(card) || this.deployRuns(card)) {
          problem = "stopped, because the card came back or a deploy of it started";
          break;
        }
        try {
          await step.run();
          deleted.push(step.what);
        } catch (error) {
          problem = `${step.what} failed: ${error instanceof Error ? error.message : String(error)}`;
          break;
        }
      }
    } finally {
      this.deletingStorage.delete(card);
    }
    const done = deleted.length > 0 ? deleted.join(", ") : "nothing";
    this.insertRevision(
      caller.actor,
      `Deleted ${done} of the removed app ${card}${problem ? `; ${problem}` : ""}`,
      [],
      null,
    );
    this.broadcast();
    if (problem) return Response.json({ error: `Deleted ${done}; ${problem}.`, deleted }, { status: 502 });
    return Response.json({ deleted });
  }

  /**
   * K-821: the finished deploys of a card, newest first, and whether a rollback can go back to each. The newest one
   * serves now. Static and Worker deploys need their Cloudflare version; a Compose deploy needs the kept build before
   * the last one on its machine, so only the deploy before the current one counts; a preview has no rollback.
   */
  private rollbackChoices(card: string): Array<RollbackChoice> {
    const rows = this.sql<DeployRow>(
      "SELECT * FROM deploys WHERE resource_id = ? AND kind = 'deploy' AND state = 'done' ORDER BY expires_at DESC LIMIT 6",
      card,
    );
    const current = rows[0];
    return rows.map((row, index) => {
      const why =
        index === 0
          ? "This deploy serves now."
          : isPreview(row.environment)
            ? "A preview has no rollback."
            : row.app === "compose"
              ? index !== 1
                ? "The machine keeps only the build before the last one."
                : row.images === null
                  ? "The machine kept no images of this deploy."
                  : null
              : row.version_id === null
                ? "kitshn has no Cloudflare version of this deploy."
                : row.version_id === current?.version_id
                  ? "This version serves now."
                  : null;
      return {
        deployId: row.id,
        sha: row.sha,
        at: row.expires_at - DEPLOY_MS,
        run: row.run_id === null ? null : `${row.run_id}.${row.run_attempt ?? "1"}`,
        note: row.reason,
        why,
      };
    });
  }

  private rollbackChoicesResponse(card: string) {
    if (!this.deployedCards(card).includes(card))
      return Response.json({ error: `A deploy did not make the card "${card}" (K-821).` }, { status: 409 });
    return Response.json({ choices: this.rollbackChoices(card) });
  }

  private async rollbackResponse(caller: Caller, card: string, deployId: string) {
    const result = await this.rollbackCard(caller.actor, card, deployId, null);
    if ("error" in result) return Response.json({ error: result.error }, { status: 409 });
    this.broadcast();
    return Response.json(result);
  }

  /**
   * K-821: rolls one card back to an earlier finished deploy. A static or Worker card deploys that Cloudflare version
   * again at once; a Compose card starts its kept build on its machine as a job. The new deploy row repeats the old
   * one, so the card, Undo and the next rollback see it as the current deploy. Data never rolls back; the vars and
   * secrets (or the Compose params) of that deploy come back with it.
   */
  private async rollbackCard(
    actor: Actor,
    card: string,
    deployId: string,
    group: string | null,
  ): Promise<{ readonly note: string; readonly jobId: number | null } | { readonly error: string }> {
    const resource = this.state.resources.get(card);
    if (!resource || !this.deployedCards(card).includes(card))
      return { error: `A deploy did not make the card "${card}" (K-821).` };
    if (this.state.paused)
      return { error: "kitshn is paused, so it rolls nothing back until Resume (K-1504)." };
    const choice = this.rollbackChoices(card).find((item) => item.deployId === deployId);
    if (!choice) return { error: `${deployId} is not one of the last finished deploys of ${resource.name}.` };
    if (choice.why !== null) return { error: choice.why };
    // The newest row counts as the current deploy, so a deploy that ends after the rollback would hide it.
    if (this.deployRuns(card)) return { error: "A deploy of this card runs now. Roll back after it ends." };
    const [target] = this.sql<DeployRow>("SELECT * FROM deploys WHERE id = ?", deployId);
    if (!target) return { error: `kitshn knows no deploy ${deployId}.` };
    // The daemon keeps a Compose build by the deploy that built it; a rollback row repeats that build.
    const origin = target.origin ?? target.id;
    const refusal = this.repoRefusal(target.repo_id);
    if (refusal) return { error: refusal };
    const sha = target.sha.slice(0, 7);
    const id = crypto.randomUUID();
    const insert = (state: "done" | "running", jobId: number | null) =>
      this.sql(
        `INSERT INTO deploys (id, repo, repo_id, environment, resource_id, address, script, starts_in, kind, sha, state,
           expires_at, branch, app, machine_id, job_id, compose_file, addresses, worker, app_key, reason, version_id,
           run_id, run_attempt, images, needs, origin, workflow)
         SELECT ?, repo, repo_id, environment, resource_id, address, script, starts_in, kind, sha, ?, ?, branch, app,
           machine_id, ?, compose_file, addresses, worker, app_key, ?, version_id, NULL, NULL, images, needs, ?, workflow
         FROM deploys WHERE id = ?`,
        id,
        state,
        Date.now() + DEPLOY_MS,
        jobId,
        `rollback to ${sha}`,
        origin,
        deployId,
      );
    if (target.app !== "compose") {
      const api = this.api();
      if (!api) return { error: "kitshn has no Cloudflare API token here." };
      try {
        await api(
          "POST",
          `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${target.script}/deployments`,
          {
            strategy: "percentage",
            versions: [{ version_id: target.version_id, percentage: 100 }],
          },
        );
      } catch (error) {
        return {
          error: `Cloudflare refused the rollback: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      this.ctx.storage.transactionSync(() => {
        insert("done", null);
        this.insertRevision(actor, `Rolled back ${resource.name} to ${sha} (K-821)`, [], null);
      });
      return {
        note: `${resource.name} serves ${sha} again, with the vars and secrets of that deploy; its data did not roll back.`,
        jobId: null,
      };
    }
    const machine = resource.machine ? this.state.machines.get(resource.machine) : undefined;
    if (!machine) return { error: `${resource.name} runs on no known machine.` };
    const offMachine = this.redeployRefusal(machine.id, card);
    if (offMachine) return { error: offMachine };
    if (!this.machineView(machine).status?.capabilities?.includes("compose-rollback"))
      return { error: `Update the daemon on ${machine.name} first: it cannot roll back yet (K-821).` };
    const jobId = this.ctx.storage.transactionSync(() => {
      const queued = this.queueKitshnJob(
        machine.id,
        {
          kind: "compose-rollback",
          deployId: origin,
          allowed: allowedFor(machine, target.repo),
          project: card,
          name: target.address.slice(0, -this.env.KITSHN_ZONE.length - 1),
          environment: target.environment,
          repo: target.repo,
          file: target.compose_file,
          group,
        },
        actor,
        Date.now() + DEPLOY_MS,
      );
      insert("running", queued);
      this.insertRevision(actor, `Rolled back ${resource.name} to ${sha} (K-821)`, [], null);
      return queued;
    });
    this.deliverJobs();
    return {
      note: `${machine.name} starts the kept build ${sha} of ${resource.name}, with the params of that deploy; its data does not roll back.`,
      jobId,
    };
  }

  /**
   * K-821: the rollback of the run that made the current deploy of a card: each card of that run whose current deploy
   * is still from it, back to its newest finished deploy before the run, an app before the apps that it needs.
   */
  private runRollbackPlan(card: string): Array<RunRollbackStep> | { readonly error: string } {
    const [current] = this.sql<DeployRow>(
      "SELECT * FROM deploys WHERE resource_id = ? AND kind = 'deploy' AND state = 'done' ORDER BY expires_at DESC LIMIT 1",
      card,
    );
    if (!current?.run_id)
      return { error: "The current deploy of this card came from no workflow run (K-821)." };
    const ofRun = this.sql<DeployRow>(
      "SELECT * FROM deploys WHERE repo_id = ? AND run_id = ? AND run_attempt = ? AND kind = 'deploy' AND state = 'done'",
      current.repo_id,
      current.run_id,
      current.run_attempt,
    );
    const steps: Array<RunRollbackStep & { readonly key: string; readonly needs: ReadonlyArray<string> }> =
      [];
    for (const row of ofRun) {
      const resource = this.state.resources.get(row.resource_id);
      const [newest] = this.sql<{ id: string }>(
        "SELECT id FROM deploys WHERE resource_id = ? AND kind = 'deploy' AND state = 'done' ORDER BY expires_at DESC LIMIT 1",
        row.resource_id,
      );
      if (!resource || newest?.id !== row.id) continue;
      const [before] = this.sql<DeployRow>(
        `SELECT * FROM deploys WHERE resource_id = ? AND kind = 'deploy' AND state = 'done' AND expires_at < ?
         AND (run_id IS NULL OR run_id != ? OR run_attempt != ?) ORDER BY expires_at DESC LIMIT 1`,
        row.resource_id,
        row.expires_at,
        current.run_id,
        current.run_attempt,
      );
      const choice = before
        ? this.rollbackChoices(row.resource_id).find((item) => item.deployId === before.id)
        : undefined;
      const why = !before
        ? "The card has no deploy before the run."
        : choice === undefined
          ? "The deploy before the run is older than the last 5."
          : choice.why;
      steps.push({
        card: row.resource_id,
        name: resource.name,
        deployId: before?.id ?? null,
        sha: before?.sha ?? null,
        why,
        key: row.app_key,
        needs: JSON.parse(row.needs ?? "[]") as Array<string>,
      });
    }
    const keys = new Set(steps.map((step) => step.key));
    const order = deployOrder(
      Object.fromEntries(
        steps.map((step) => [step.key, { needs: { apps: step.needs.filter((key) => keys.has(key)) } }]),
      ),
    );
    if ("error" in order) return { error: order.error };
    // An app goes back before the apps that it needs, the reverse of the deploy order.
    return [...order.order]
      .reverse()
      .flatMap((key) => steps.filter((step) => step.key === key))
      .map(({ key: _key, needs: _needs, ...step }) => step);
  }

  private runRollbackPlanResponse(card: string) {
    const plan = this.runRollbackPlan(card);
    if ("error" in plan) return Response.json({ error: plan.error }, { status: 409 });
    return Response.json({ steps: plan });
  }

  /** K-821: starts a run rollback; a Compose step waits for its job, and the job result goes on (continueRollback). */
  private async runRollback(caller: Caller, card: string) {
    const plan = this.runRollbackPlan(card);
    if ("error" in plan) return Response.json({ error: plan.error }, { status: 409 });
    const blocked = plan.find((step) => step.why !== null);
    if (blocked) return Response.json({ error: `${blocked.name}: ${blocked.why}` }, { status: 409 });
    const busy = new Set(
      this.sql<{ steps: string }>("SELECT steps FROM rollbacks WHERE state = 'running'").flatMap((row) =>
        (JSON.parse(row.steps) as Array<RunRollbackStep>).map((step) => step.card),
      ),
    );
    const overlap = plan.find((step) => busy.has(step.card));
    if (overlap)
      return Response.json(
        { error: `A run rollback of ${overlap.name} runs now. Wait until it ends.` },
        { status: 409 },
      );
    const id = crypto.randomUUID();
    this.sql(
      "INSERT INTO rollbacks (id, steps, next, state, actor, notes) VALUES (?, ?, 0, 'running', ?, '[]')",
      id,
      JSON.stringify(plan),
      JSON.stringify(caller.actor),
    );
    await this.advanceRollback(id);
    this.broadcast();
    const [row] = this.sql<{ state: string; notes: string }>(
      "SELECT state, notes FROM rollbacks WHERE id = ?",
      id,
    );
    return Response.json({
      id,
      state: row?.state ?? "failed",
      notes: JSON.parse(row?.notes ?? "[]") as Array<string>,
    });
  }

  /** K-821: the run rollbacks that a call of advanceRollback works on now; a restart empties it. */
  private readonly advancing = new Set<string>();

  /** K-821: runs the next steps of a run rollback until one waits for a machine, fails, or the last one is done. */
  private async advanceRollback(id: string) {
    this.advancing.add(id);
    try {
      for (;;) {
        const [row] = this.sql<{ steps: string; next: number; state: string; actor: string; notes: string }>(
          "SELECT steps, next, state, actor, notes FROM rollbacks WHERE id = ?",
          id,
        );
        if (!row || row.state !== "running") return;
        const steps = JSON.parse(row.steps) as Array<RunRollbackStep>;
        const notes = JSON.parse(row.notes) as Array<string>;
        const step = steps[row.next];
        if (!step) {
          this.finishRollback(id, "done", notes);
          return;
        }
        const result = await this.rollbackCard(
          JSON.parse(row.actor) as Actor,
          step.card,
          step.deployId ?? "",
          id,
        );
        if ("error" in result) {
          this.finishRollback(id, "failed", [
            ...notes,
            `${step.name}: ${result.error} The rollback stopped here.`,
          ]);
          return;
        }
        notes.push(result.note);
        this.sql(
          "UPDATE rollbacks SET next = next + ?, notes = ?, job_id = ? WHERE id = ?",
          result.jobId === null ? 1 : 0,
          JSON.stringify(notes),
          result.jobId,
          id,
        );
        if (result.jobId !== null) return;
      }
    } finally {
      this.advancing.delete(id);
    }
  }

  /** K-821: the job of a Compose step of a run rollback ended; the run goes on, or stops at a failed job. */
  private continueRollback(id: string, error: string | null) {
    const [row] = this.sql<{ notes: string }>(
      "SELECT notes FROM rollbacks WHERE id = ? AND state = 'running'",
      id,
    );
    if (!row) return;
    const notes = JSON.parse(row.notes) as Array<string>;
    if (error !== null) {
      this.finishRollback(id, "failed", [...notes, `${error} The rollback stopped here.`]);
      return;
    }
    this.sql("UPDATE rollbacks SET next = next + 1, job_id = NULL WHERE id = ?", id);
    // Set now, so the alarm does not settle the rollback before the next step starts.
    this.advancing.add(id);
    void this.advanceRollback(id).then(() => this.broadcast());
  }

  /**
   * K-821: stops each run rollback that waits for nothing: its job ended without a result (it expired, the repo was
   * blocked, the delivery failed), or a restart cut off a step. A job that failed only because its machine went
   * offline still waits until it expires, because kitshn takes its late result. Returns how many stopped.
   */
  private settleRollbacks() {
    const stuck = this.sql<{ id: string; notes: string; job_id: number | null }>(
      `SELECT rollbacks.id, rollbacks.notes, rollbacks.job_id FROM rollbacks LEFT JOIN jobs ON jobs.id = rollbacks.job_id
       WHERE rollbacks.state = 'running' AND (jobs.id IS NULL OR (jobs.state NOT IN ('queued', 'sent')
         AND NOT (jobs.state = 'failed' AND jobs.output = '${OFFLINE_OUTPUT}' AND jobs.expires_at > ?)))`,
      Date.now(),
    ).filter((row) => !this.advancing.has(row.id));
    for (const row of stuck)
      this.finishRollback(row.id, "failed", [
        ...(JSON.parse(row.notes) as Array<string>),
        row.job_id === null
          ? "kitshn restarted during this step, so it may or may not have rolled back. Check the card. The rollback stopped here."
          : "The machine sent no result for the last step. The rollback stopped here.",
      ]);
    return stuck.length;
  }

  /** K-821: the end of a run rollback; History shows it, because the toast shows only the steps before a job. */
  private finishRollback(id: string, state: "done" | "failed", notes: ReadonlyArray<string>) {
    const [row] = this.sql<{ actor: string }>(
      "UPDATE rollbacks SET state = ?, notes = ?, job_id = NULL WHERE id = ? AND state = 'running' RETURNING actor",
      state,
      JSON.stringify(notes),
      id,
    );
    if (!row) return;
    this.recordRevision(
      JSON.parse(row.actor) as Actor,
      state === "done" ? "The run rollback ended (K-821)" : `The run rollback stopped: ${notes.at(-1) ?? ""}`,
    );
  }

  /** K-909: removes a deployed app; the card panel, the palette and `DELETE /api/apps/<card>` all come here. */
  private async removeApp(caller: Caller, id: string) {
    try {
      if (!this.deployedCards(id).includes(id))
        return Response.json(
          { error: `A deploy did not make the card "${id}", so it is not an app (K-909).` },
          { status: 409 },
        );
      return Response.json(await this.commitApps(caller.actor, removeAppChanges(this.state, id), null));
    } catch (error) {
      if (error instanceof RuleError) return Response.json({ error: error.message }, { status: 409 });
      return Response.json({ error: `kitshn could not remove the app: ${String(error)}` }, { status: 502 });
    }
  }

  /**
   * K-909: commits changes that can remove or restore apps, with the work in Cloudflare and on machines that
   * goes with them. Returns the revision and a note for each app: what started or stopped, or why not.
   */
  private async commitApps(
    actor: Actor,
    changes: ReadonlyArray<Change>,
    undo: UndoOf | null,
  ): Promise<{ revision: number | null; notes: Array<string> }> {
    const apps = changes.flatMap((change) => (change._tag === "app" ? [change] : []));
    // Check first, so that a refused change tears nothing down.
    this.checked(changes);
    // K-410: a Worker address goes before its card, because the card keeps its Access application.
    for (const { before, after } of apps) {
      const teardown = before && !after ? appTeardown(before, this.env.KITSHN_ZONE) : null;
      if (teardown?.kind !== "worker" && teardown?.kind !== "domains") continue;
      const api = this.api();
      if (!api) throw new RuleError("kitshn has no Cloudflare API token here.");
      if (teardown.kind === "worker") {
        await this.removeWorker(api, teardown.addresses, teardown.script);
        continue;
      }
      await this.removeDomains(api, teardown.addresses, teardown.script);
      // A removed app runs no crons either, so it does not write to its kept storage; Undo puts them back. A script
      // that does not exist (a first upload failed, or someone deleted it) has none, and there is nothing to keep.
      const kept = await api(
        "PUT",
        `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${teardown.script}/schedules`,
        [],
      ).then(
        () => true,
        (error: unknown) =>
          error instanceof CloudflareError && error.status === 404 ? false : Promise.reject(error),
      );
      if (!kept) continue;
      // K-909: the kept script is listed under "Orphaned" while its card is gone, with a way to delete it.
      this.sql(
        "INSERT OR REPLACE INTO worker_storage (card_id, kind, name, cf_id) VALUES (?, 'script', 'script', ?)",
        before!.id,
        teardown.script,
      );
    }
    // The state can change while Cloudflare answers.
    const conflict = conflictOf(this.state, changes);
    if (conflict) throw new RuleError(`${conflict._tag} "${conflict.id}" changed meanwhile. Try again.`);
    // K-909: the stop of a removed Compose app that the machine runs now ends first. A closed preview has its
    // own teardown (K-904), which the undo leaves alone.
    const restored = apps.flatMap(({ after }) =>
      after?.kind === "site.compose" && !this.closedPreview(after.id) ? [after] : [],
    );
    for (const { after } of apps)
      if (after?.kind === "site.worker" && this.deletingStorage.has(after.id))
        throw new RuleError(
          `kitshn deletes the storage of ${after.name} now; undo after it finishes (K-909).`,
        );
    for (const card of restored)
      if (composeUndo(removalDown(this.query, card.id)) === "refuse")
        throw new RuleError(`The machine is stopping ${card.name} now; undo after it finishes (K-909).`);
    const revision = this.commit(actor, changes, undo);
    // A stop that still waits goes, and the app starts again (a short restart where it never stopped).
    for (const card of restored) {
      failQueuedDowns(this.query, card.id, "The undo of the removal replaced this job (K-909).");
      dropLiveSite(this.query, card.id);
    }
    if (restored.length > 0) this.load();
    const notes: Array<string> = [];
    for (const { before, after } of apps) {
      if (after) notes.push(await this.restartApp(actor, after));
      else if (before?.kind === "site.compose") notes.push(this.stopCompose(actor, before));
    }
    if (apps.length > 0) {
      this.deliverJobs();
      this.broadcast();
    }
    return { revision, notes };
  }

  /**
   * K-909: the cards that a deploy made, which "Remove app" accepts: a deploy with a repo id, or a finished one
   * from before the repo id (K-819). With an id, only that card. The card panel reads the same list.
   */
  private deployedCards(id: string | null = null): Array<string> {
    return this.sql<{ resource_id: string }>(
      `SELECT DISTINCT resource_id FROM deploys WHERE kind = 'deploy' AND (repo_id IS NOT NULL OR state = 'done')
       AND (? IS NULL OR resource_id = ?)`,
      id,
      id,
    )
      .map((row) => row.resource_id)
      .filter((card) => this.state.resources.has(card));
  }

  /** K-909, K-821: the deployed cards and, of them, the preview cards, from one read of the deploy rows. */
  private deployedAndPreviewCards() {
    const rows = this.sql<{ resource_id: string; preview: number }>(
      `SELECT resource_id, MAX(environment GLOB 'pr-[0-9]*') AS preview FROM deploys
       WHERE kind = 'deploy' AND (repo_id IS NOT NULL OR state = 'done') GROUP BY resource_id`,
    ).filter((row) => this.state.resources.has(row.resource_id));
    return {
      deployedCards: rows.map((row) => row.resource_id),
      previewCards: rows.filter((row) => row.preview === 1).map((row) => row.resource_id),
    };
  }

  /** K-820: the cards on the map whose newest deploy failed or was skipped. */
  private deployNotes(): Record<string, DeployNote> {
    const notes: Record<string, DeployNote> = {};
    for (const row of this.sql<{ resource_id: string; state: string; reason: string | null }>(
      `SELECT resource_id, state, reason FROM deploys AS newest WHERE kind = 'deploy' AND state IN ('failed', 'skipped')
       AND rowid = (SELECT MAX(rowid) FROM deploys WHERE resource_id = newest.resource_id AND kind = 'deploy')`,
    ))
      if (this.state.resources.has(row.resource_id))
        notes[row.resource_id] = {
          state: row.state === "skipped" ? "skipped" : "failed",
          reason: row.reason ?? "The deploy failed; its workflow run has the log.",
        };
    return notes;
  }

  /** K-718, K-909: the newest finished deploy of a card, or null. */
  private lastDone(id: string): DeployRow | null {
    const [row] = this.sql<DeployRow>(
      "SELECT * FROM deploys WHERE resource_id = ? AND kind = 'deploy' AND state = 'done' ORDER BY expires_at DESC LIMIT 1",
      id,
    );
    return row ?? null;
  }

  /** K-909: the newest plan of this environment was a teardown, so its pull request closed (K-904). */
  private closedPreview(id: string) {
    const [row] = this.sql<{ kind: string }>(
      "SELECT kind FROM deploys WHERE resource_id = ? ORDER BY expires_at DESC LIMIT 1",
      id,
    );
    return row?.kind === "teardown";
  }

  /** K-718, K-909: the last finished deploy as the start of an app reads it. */
  private lastDeployOf(row: DeployRow): LastDeploy {
    return {
      app: row.app,
      repo: row.repo,
      branch: row.branch,
      resourceId: row.resource_id,
      environment: row.environment,
      name: row.address.slice(0, -this.env.KITSHN_ZONE.length - 1),
      composeFile: row.compose_file,
    };
  }

  /** K-718, K-909: whether a machine can start the last good build of a card. */
  private redeployFacts(machine: Machine, card: string, repo: string) {
    return {
      canRedeploy: ["compose-redeploy", "compose-guard"].every(
        (capability) => this.machineView(machine).status?.capabilities?.includes(capability) ?? false,
      ),
      takesDeploys: machine.labels.includes("deploy"),
      runsCard: this.state.resources.get(card)?.machine === machine.id,
      allowed: allowedFor(machine, repo),
    };
  }

  /** K-909: stops a removed Compose app and keeps its volumes. The job waits for the machine, however long. */
  private stopCompose(actor: Actor, card: AppCard) {
    const teardown = appTeardown(card, this.env.KITSHN_ZONE);
    if (teardown.kind !== "compose") throw new Error(`${card.name} is no Compose app.`);
    const machine = teardown.machineId ? this.state.machines.get(teardown.machineId) : undefined;
    if (!machine) return `kitshn knows no machine of ${card.name}, so nothing stops there.`;
    this.queueKitshnJob(machine.id, teardown.command, actor, NEVER);
    const when = this.jobMachines().has(machine.id) ? "now" : `when ${machine.name} comes online with a key`;
    return `${card.name} stops on ${machine.name} ${when}; its volumes stay on the machine.`;
  }

  /** K-909: the undo of a removal starts the app again where it can, and says why where it cannot. */
  private async restartApp(actor: Actor, card: AppCard) {
    if (card.kind === "site.worker") return await this.reattachWorker(card);
    const done = this.lastDone(card.id);
    const machine = done?.machine_id ? this.state.machines.get(done.machine_id) : undefined;
    const refusal = this.state.paused
      ? "kitshn is paused, so it starts nothing until Resume."
      : done
        ? this.repoRefusal(done.repo_id)
        : null;
    const plan = appRestart(
      done ? this.lastDeployOf(done) : null,
      refusal,
      this.closedPreview(card.id),
      machine ? this.redeployFacts(machine, card.id, done?.repo ?? "") : null,
    );
    const back = `${card.name} is back on the map`;
    if (plan.kind === "none") return `${back}, but kitshn did not start it: ${plan.reason}`;
    if (plan.kind === "redeploy") {
      if (!machine) throw new Error("A redeploy plan without its machine.");
      this.queueKitshnJob(machine.id, plan.command, actor, Date.now() + DEPLOY_MS);
      return `${back} and starts its last good build on ${machine.name}.`;
    }
    try {
      const repo = await this.dispatchBuild(
        done?.repo_id ?? "",
        plan.branch,
        done?.workflow ?? AGENT_WORKFLOW,
      );
      return `${back}; kitshn started a build of ${repo} from ${plan.branch}.`;
    } catch (error) {
      return `${back}, but the build did not start: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private authorized(caller: Caller) {
    return this.hasAdmin(caller.visitor);
  }

  private hasAdmin(visitor: Visitor) {
    const admin = this.state.resources.get(ADMIN_RESOURCE_ID);
    return admin !== undefined && visitorLevel(this.state, admin, visitor, Date.now()) === "control";
  }

  private snapshot(me: Actor, repos: ReadonlyArray<RepoView> = this.repoViews()): Snapshot {
    const desired = this.desired(Date.now());
    const loginError = this.meta("login_error");
    return {
      circles: [...this.state.circles.values()],
      resources: [...this.state.resources.values()],
      places: Object.fromEntries(this.state.places) as Record<string, Point>,
      shareSettings: Object.fromEntries(this.state.shareSettings) as Record<string, ShareSetting>,
      stacks: [...this.state.stacks.values()],
      revisions: this.revisions,
      access: accessStates(desired, this.access),
      accessWarnings: [
        ...this.accessWarnings,
        ...(loginError ? [loginError] : []),
        ...loginWarnings(desired, this.access),
      ],
      signOutWarning: signOutWarning(this.signOutLeft()),
      paused: this.state.paused,
      repos,
      ...this.deployedAndPreviewCards(),
      orphanWorkers: this.orphanWorkers(),
      deployNotes: this.deployNotes(),
      icons: Object.fromEntries([...this.iconHashes].filter(([id]) => this.state.resources.has(id))),
      pausedBy: this.state.paused ? parsePausedBy(this.meta("paused_by"), this.meta("paused_at")) : null,
      machines: [...this.state.machines.values()].map((machine) => this.machineView(machine)),
      jobs: this.recentJobs(10, 2000),
      version: this.env.KITSHN_VERSION,
      accessTeam: this.env.ACCESS_TEAM_DOMAIN,
      zone: this.env.KITSHN_ZONE,
      revision: this.lastRevision(),
      me,
    };
  }

  private machineView(machine: Machine): MachineView {
    const socket = this.openSocket(machine.id);
    const attachment = socket ? attachmentOf(socket) : null;
    const live = attachment?.kind === "machine" ? attachment : null;
    return {
      machine,
      online: socket !== null,
      lastSeen: this.presence.get(machine.id)?.lastSeen ?? null,
      status: live?.status ?? null,
      sample: live?.sample ?? null,
      os: this.presence.get(machine.id)?.os ?? null,
      keyFailure: this.keyFailures.get(machine.id) ?? null,
      orphanVolumes: orphanVolumes(live?.volumes ?? [], this.state),
    };
  }

  /** The newest open socket of a machine that passed its check (K-1704), or null. */
  private openSocket(machineId: string): WebSocket | null {
    const open = this.checkedSockets(machineId).filter((socket) => socket.readyState === WebSocket.OPEN);
    return open.at(-1) ?? null;
  }

  /** K-1704: the sockets of a machine that kitshn reads and sends jobs to. */
  private checkedSockets(machineId: string) {
    return this.ctx.getWebSockets(machineId).filter((socket) => {
      const attachment = attachmentOf(socket);
      return attachment?.kind === "machine" && attachment.check !== "waiting";
    });
  }

  /** Sends one changed machine to every open map, instead of a whole snapshot. */
  private sendMachine(machine: Machine) {
    const message: ServerMessage = { type: "machine", view: this.machineView(machine) };
    for (const socket of this.ctx.getWebSockets("map")) send(socket, message);
  }

  private broadcast() {
    const repos = this.repoViews();
    for (const socket of this.ctx.getWebSockets("map")) {
      const attachment = attachmentOf(socket);
      if (attachment?.kind !== "map") continue;
      const caller = attachment.caller;
      if (!this.authorized(caller)) {
        socket.close(4003, "You lost access to the kitshn admin.");
        continue;
      }
      send(socket, { type: "snapshot", snapshot: this.snapshot(caller.actor, repos) });
    }
  }

  private async handle(
    caller: Caller,
    message: ClientMessage,
  ): Promise<Extract<ServerMessage, { type: "result" }>> {
    try {
      const { revision, notes } =
        message.type === "apply"
          ? { revision: this.apply(caller.actor, message.edits), notes: [] }
          : message.type === "undo"
            ? await this.undo(caller.actor, message.revision)
            : await this.undoItem(caller.actor, message.item);
      return { type: "result", requestId: message.requestId, ok: true, revision, notes };
    } catch (error) {
      if (!(error instanceof RuleError)) throw error;
      return { type: "result", requestId: message.requestId, ok: false, error: error.message };
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    // The join exchange is public: the join code itself is the secret (K-602).
    if (path === "/join/exchange" && request.method === "POST") return this.exchangeJoin(request);
    if (path === "/join/rekey" && request.method === "POST") return this.rekey(request);
    if (path === "/internal/offline")
      return this.offlineInfo(new URL(request.url).searchParams.get("address") ?? "");
    if (path === "/internal/public-cards") return this.publicCards();
    if (path === "/internal/badge") return this.badge(new URL(request.url).searchParams);
    if (path === "/internal/content") return this.contentDecision((await request.json()) as ContentRequest);
    if (path.startsWith("/deploy/")) {
      const header = request.headers.get("x-kitshn-deployer");
      if (!header) return new Response("The Worker sent no deployer.", { status: 500 });
      if (path === "/deploy/archive" || path === "/deploy/params")
        return this.deployFile(path, JSON.parse(header) as Deployer, request);
      return this.deployStep(path, JSON.parse(header) as Deployer, await request.json().catch(() => null));
    }
    const header = request.headers.get("x-kitshn-caller");
    if (!header) return new Response("The Worker sent no caller.", { status: 500 });
    const caller = JSON.parse(header) as Caller;
    if (path === "/connect") return this.connectMachine(request, caller);
    // Only the Worker's fresh passkey route sends this path (K-1504).
    if (path === "/fresh/resume" && request.method === "POST") return this.resume(caller);
    if (path.startsWith("/agent/")) return this.agentRequest(path, request, caller);
    if (path.startsWith("/connect/deploys/")) return this.deploySource(path, caller);
    if (!this.authorized(caller)) {
      return Response.json(
        { error: "You have no control level on the kitshn admin (K-104)." },
        { status: 403 },
      );
    }
    if (path.startsWith("/api/icons/") && request.method === "GET")
      return this.icon(path.slice("/api/icons/".length));
    if (path === "/api/ws") {
      if (request.headers.get("upgrade") !== "websocket")
        return new Response("Expected a WebSocket.", { status: 426 });
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server, ["map"]);
      server.serializeAttachment({ kind: "map", caller } satisfies Attachment);
      send(server, { type: "snapshot", snapshot: this.snapshot(caller.actor) });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (path === "/api/state" && request.method === "GET") return Response.json(this.snapshot(caller.actor));
    if (path === "/api/sign-out" && request.method === "POST") return this.signOut(caller);
    if (path === "/api/sign-out/retry" && request.method === "POST") return this.retrySignOut(caller);
    if (path === "/api/machines" && request.method === "POST")
      return this.addMachine(caller, await request.json().catch(() => null), new URL(request.url).origin);
    if (path.startsWith("/api/machines/") && path.endsWith("/rotate-key") && request.method === "POST")
      return this.rotateFromPanel(
        caller,
        decodeURIComponent(path.slice("/api/machines/".length, -"/rotate-key".length)),
      );
    if (path.startsWith("/api/machines/") && path.endsWith("/reset-key") && request.method === "POST")
      return this.resetKey(
        caller,
        decodeURIComponent(path.slice("/api/machines/".length, -"/reset-key".length)),
      );
    if (path.startsWith("/api/machines/") && request.method === "POST")
      return this.updateMachine(
        caller,
        decodeURIComponent(path.slice("/api/machines/".length)),
        await request.json().catch(() => null),
      );
    if (path.startsWith("/api/machines/") && request.method === "DELETE")
      return this.removeMachine(caller, decodeURIComponent(path.slice("/api/machines/".length)));
    if (path.startsWith("/api/worker-storage/") && request.method === "DELETE")
      return await this.deleteOrphanWorker(
        caller,
        decodeURIComponent(path.slice("/api/worker-storage/".length)),
      );
    if (path.startsWith("/api/apps/") && path.endsWith("/rollbacks") && request.method === "GET")
      return this.rollbackChoicesResponse(
        decodeURIComponent(path.slice("/api/apps/".length, -"/rollbacks".length)),
      );
    if (path.startsWith("/api/apps/") && path.endsWith("/rollback") && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { deployId?: unknown } | null;
      return await this.rollbackResponse(
        caller,
        decodeURIComponent(path.slice("/api/apps/".length, -"/rollback".length)),
        String(body?.deployId ?? ""),
      );
    }
    if (path.startsWith("/api/apps/") && path.endsWith("/run-rollback")) {
      const card = decodeURIComponent(path.slice("/api/apps/".length, -"/run-rollback".length));
      if (request.method === "GET") return this.runRollbackPlanResponse(card);
      if (request.method === "POST") return await this.runRollback(caller, card);
    }
    if (path.startsWith("/api/apps/") && request.method === "DELETE")
      return this.removeApp(caller, decodeURIComponent(path.slice("/api/apps/".length)));
    if (path === "/api/repos/check" && request.method === "POST") return await this.checkReposOnGitHub();
    if (path.startsWith("/api/repos/") && request.method === "POST")
      return await this.setRepoState(
        caller,
        decodeURIComponent(path.slice("/api/repos/".length)),
        await request.json().catch(() => null),
      );
    if (path === "/api/jobs" && request.method === "POST")
      return this.addJob(caller, await request.json().catch(() => null));
    if (path === "/api/jobs" && request.method === "GET") return Response.json(this.recentJobs(100));
    if (path === "/api/devices" && request.method === "GET") return this.listDevices();
    if (path === "/api/library" && request.method === "GET") return Response.json(this.libraryItems());
    if ((path === "/api/pages" || path === "/api/files") && request.method === "POST")
      return this.upload(caller, request, path === "/api/pages" ? "page" : "file").catch((error: unknown) => {
        if (error instanceof RuleError) return Response.json({ error: error.message }, { status: 400 });
        throw error;
      });
    if (path.startsWith("/api/library/") && path.endsWith("/content") && request.method === "GET")
      return this.preview(path.slice("/api/library/".length, -"/content".length));
    if (path.startsWith("/api/library/") && request.method === "DELETE")
      return this.deleteItem(caller, path.slice("/api/library/".length));
    if (path === "/api/devices" && request.method === "POST")
      return this.addDevice(await request.json().catch(() => null));
    if (path === "/api/undo-item" && request.method === "GET") {
      // K-1507: the menu asks before it offers the per-item undo; the same rule over the whole History.
      const query = new URL(request.url).searchParams;
      const kind = query.get("kind");
      const id = query.get("id");
      if ((kind !== "card" && kind !== "circle") || !id)
        return Response.json(
          { error: "Name the item with kind=card or kind=circle and an id." },
          { status: 400 },
        );
      return Response.json(
        undoAnswer(this.state, this.storedRevisions(), caller.actor, { item: { kind, id } }),
      );
    }
    if (path === "/api/undo" && request.method === "GET") {
      // K-1508: History asks once for the caller's newest row, by the same checks as the undo.
      const revision = Number(new URL(request.url).searchParams.get("revision"));
      if (!Number.isSafeInteger(revision) || revision <= 0)
        return Response.json({ error: "Name the revision with revision=<id>." }, { status: 400 });
      return Response.json(undoAnswer(this.state, this.storedRevisions(), caller.actor, { revision }));
    }
    const type = API_MESSAGES[path];
    if (type !== undefined) {
      if (request.method !== "POST") return new Response("Use POST.", { status: 405 });
      let message: ClientMessage;
      try {
        message = decodeClientMessage({
          ...((await request.json()) as object),
          type,
          requestId: "http",
        });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
      const result = await this.handle(caller, message);
      return Response.json(result, { status: result.ok ? 200 : 409 });
    }
    return new Response("Not found.", { status: 404 });
  }

  override async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    const attachment = attachmentOf(socket);
    if (attachment === null) return;
    if (attachment.kind === "machine") {
      await this.machineMessage(
        socket,
        attachment,
        typeof data === "string" ? data : new TextDecoder().decode(data),
      );
      return;
    }
    const caller = attachment.caller;
    if (!this.authorized(caller)) {
      socket.close(4003, "You lost access to the kitshn admin.");
      return;
    }
    let message: ClientMessage;
    try {
      message = decodeClientMessage(
        JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)),
      );
    } catch (error) {
      socket.close(4000, `kitshn cannot read the message: ${String(error).slice(0, 100)}`);
      return;
    }
    try {
      send(socket, await this.handle(caller, message));
    } catch (error) {
      // Every request gets an answer, so a map never waits forever on an edit it shows (held.ts).
      console.error(`kitshn could not handle a ${message.type} request: ${String(error)}`);
      send(socket, {
        type: "result",
        requestId: message.requestId,
        ok: false,
        error: "kitshn could not save this change. Try again.",
      });
    }
  }

  override async webSocketClose(socket: WebSocket) {
    this.socketGone(socket);
  }

  override async webSocketError(socket: WebSocket) {
    this.socketGone(socket);
  }

  private socketGone(socket: WebSocket) {
    const attachment = attachmentOf(socket);
    if (attachment?.kind !== "machine") return;
    // A socket that never passed its check (K-1704) never made the machine online.
    if (attachment.check === "waiting") return;
    const others = this.checkedSockets(attachment.machineId).filter((other) => other !== socket);
    if (others.length > 0) return;
    // A job that the machine had when its connection ended has no result coming.
    requeueDowns(this.query, attachment.machineId);
    this.sql(
      `UPDATE jobs SET state = 'failed', output = '${OFFLINE_OUTPUT}' WHERE machine_id = ? AND state = 'sent'`,
      attachment.machineId,
    );
    this.setPresence(attachment.machineId, false);
  }

  /** K-605: presence rows change only when a machine goes online or offline (K-1302). */
  private setPresence(machineId: string, online: boolean) {
    const now = Date.now();
    const before = this.presence.get(machineId);
    if (before?.online === online) return;
    const os = before?.os ?? null;
    this.presence.set(machineId, { online, lastSeen: now, os });
    this.sql(
      "INSERT OR REPLACE INTO presence (id, online, last_seen, os) VALUES (?, ?, ?, ?)",
      machineId,
      online ? 1 : 0,
      now,
      os,
    );
    this.broadcast();
    // K-1108: a machine that goes off or comes back changes the offline routes of its live sites.
    void this.scheduleAlarm();
  }

  /** Machines with an open socket. Presence rows can be stale after a deploy; sockets are not. */
  private onlineMachines() {
    return new Set([...this.state.machines.keys()].filter((id) => this.openSocket(id) !== null));
  }

  /** K-1708: only a machine that signed its connection gets jobs; one without a key reports status only. */
  private jobMachines() {
    return new Set(
      [...this.state.machines.keys()].filter((id) => {
        const socket = this.openSocket(id);
        const attachment = socket ? attachmentOf(socket) : null;
        return attachment?.kind === "machine" && attachment.check === "signed";
      }),
    );
  }

  /** K-524: the system of a machine; its presence row changes only when the system does (K-1302). */
  private setMachineOs(machineId: string, os: MachineOs | null) {
    const presence = this.presence.get(machineId);
    if (!presence) throw new Error(`kitshn read a status of ${machineId} before the machine was online.`);
    if (presence.os === os) return;
    this.presence.set(machineId, { ...presence, os });
    this.sql("UPDATE presence SET os = ? WHERE id = ?", os, machineId);
  }

  /** After a restart, a presence row says online although its socket is gone; set it offline once. */
  private reconcilePresence() {
    for (const [id, value] of this.presence)
      if (value.online && this.openSocket(id) === null) this.setPresence(id, false);
    // K-909: a restart closed every socket without a close event, so no stop stays sent forever.
    for (const id of this.state.machines.keys())
      if (this.openSocket(id) === null) requeueDowns(this.query, id);
  }

  /**
   * K-604, K-1704: a daemon connects with its machine's service token; the Worker checked the Access JWT. The
   * socket then waits for the answer to its challenge. A machine without a key counts on its token alone (K-1708).
   */
  private connectMachine(request: Request, caller: Caller) {
    if (request.headers.get("upgrade") !== "websocket")
      return new Response("Expected a WebSocket.", { status: 426 });
    const machine = [...this.state.machines.values()].find(
      (item) => item.clientId === caller.visitor.clientId,
    );
    if (!machine)
      return Response.json({ error: "This service token belongs to no joined machine." }, { status: 403 });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    const start = socketStart(machine.key);
    if (start.kind === "waitsForKey") {
      // Not hibernatable and without tags, so no reader of machine sockets ever sees it. A close code, not a
      // 403, so the daemon waits long instead of trying every minute (K-1706).
      server.accept();
      server.close(KEY_RESET, "This machine has no key. Run the command of Reset key on it.");
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server, [machine.id, "machines"]);
    const challenge = newChallenge();
    const attachment = {
      kind: "machine",
      machineId: machine.id,
      since: Date.now(),
      challenge,
      check: start.kind === "token" ? "token" : "waiting",
      answered: false,
      rotateBy: null,
      status: null,
      sample: null,
    } satisfies Attachment;
    server.serializeAttachment(attachment);
    const fingerprint = start.kind === "challenge" ? start.fingerprint : null;
    send(server, { type: "challenge", challenge, fingerprint } satisfies ServerToDaemon);
    if (attachment.check === "token") this.acceptMachine(server, attachment);
    else void this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The socket passed its check (K-1704), or counts on its token (K-1708): it replaces older sockets. */
  private acceptMachine(socket: WebSocket, attachment: Extract<Attachment, { kind: "machine" }>) {
    const machine = this.state.machines.get(attachment.machineId);
    if (!machine) throw new Error(`kitshn accepted a socket of the unknown machine ${attachment.machineId}.`);
    for (const old of this.ctx.getWebSockets(machine.id))
      if (old !== socket) old.close(4001, "A newer connection of this machine replaced it.");
    socket.serializeAttachment(attachment);
    if (attachment.check === "signed") {
      this.keyFailures.delete(machine.id);
      if (machine.key?.kind !== "public") throw new Error(`${machine.name} signed without a key.`);
      send(socket, { type: "accepted", fingerprint: machine.key.fingerprint } satisfies ServerToDaemon);
    }
    if (this.presence.get(machine.id)?.online) this.sendMachine(machine);
    else this.setPresence(machine.id, true);
    // K-909: after a fast reconnect the old socket's close finds this one and requeues nothing, and a removal
    // down never expires, so its result that may never come must not keep it sent.
    requeueDowns(this.query, machine.id);
    this.deliverJobs();
    void this.scheduleAlarm();
  }

  /** K-1704, K-1708: a failed check closes the socket, and the panel shows why. */
  private refuseSocket(socket: WebSocket, machine: Machine, reason: string) {
    console.warn(`kitshn refused a connection of ${machine.name}: ${reason}`);
    this.keyFailures.set(machine.id, { at: Date.now(), reason });
    // Its close event runs socketGone, so the machine goes offline once.
    socket.close(4003, reason.slice(0, 120));
    this.sendMachine(machine);
  }

  /** K-1704: checks the one answer of a socket against the stored key. */
  private async answerChallenge(
    socket: WebSocket,
    attachment: Extract<Attachment, { kind: "machine" }>,
    machine: Machine,
    message: Record<string, unknown>,
  ) {
    const plan = answerCheck(machine.key, attachment);
    if (plan.kind === "refuse") return this.refuseSocket(socket, machine, plan.reason);
    socket.serializeAttachment({ ...attachment, answered: true } satisfies Attachment);
    const valid = await verifyText(
      plan.publicKey,
      connectText(this.env.KITSHN_HOST, machine.id, attachment.challenge),
      message["signature"],
    );
    // The socket can close and the key can change during the check: a rotation, a reset or a removal.
    if (socket.readyState !== WebSocket.OPEN) return;
    const now = this.state.machines.get(machine.id);
    if (!now || !deepEqual(now.key, machine.key))
      return this.refuseSocket(socket, machine, "The key of this machine changed during the check.");
    if (!valid)
      return this.refuseSocket(
        socket,
        machine,
        `The answer does not carry a signature of ${plan.fingerprint}.`,
      );
    this.acceptMachine(socket, { ...attachment, answered: true, check: "signed" });
  }

  /**
   * K-1705: the daemon hands over to a new key with a signature of the old one, bound to this socket. kitshn
   * stores the new key and closes the machine's sockets, so only the new key connects from then on.
   */
  private async rotateKey(
    socket: WebSocket,
    attachment: Extract<Attachment, { kind: "machine" }>,
    machine: Machine,
    message: Record<string, unknown>,
  ) {
    if (machine.key?.kind !== "public")
      return this.refuseSocket(socket, machine, "A machine without a key gets one on its next connection.");
    const publicKey = parsePublicKey(message["publicKey"]);
    if (publicKey === null)
      return this.refuseSocket(socket, machine, "The rotation has no valid public key.");
    const key = await this.publicKey(publicKey);
    const valid = await verifyText(
      machine.key.publicKey,
      rotateText(this.env.KITSHN_HOST, machine.id, attachment.challenge, publicKey),
      message["signature"],
    );
    const now = this.state.machines.get(machine.id);
    if (!now || !deepEqual(now.key, machine.key))
      return this.refuseSocket(socket, machine, "The key of this machine changed during the rotation.");
    if (!valid)
      return this.refuseSocket(
        socket,
        machine,
        `The rotation does not carry a signature of ${machine.key.fingerprint}.`,
      );
    this.setKey(
      machine,
      key,
      attachment.rotateBy ?? deviceActor(machine),
      `Rotated the key of ${machine.name} from ${machine.key.fingerprint} to ${key.fingerprint}`,
    );
    for (const old of this.ctx.getWebSockets(machine.id)) old.close(ROTATED, "key rotated");
  }

  private async publicKey(publicKey: string): Promise<Extract<MachineKey, { kind: "public" }>> {
    return { kind: "public", publicKey, fingerprint: await fingerprintOf(publicKey), since: Date.now() };
  }

  /**
   * K-1702: the one place that changes the key of a machine; each change is a History revision. `also` runs in
   * the same transaction.
   */
  private setKey(machine: Machine, key: MachineKey, actor: Actor, summary: string, also = () => {}) {
    const updated: Machine = { ...machine, key };
    this.ctx.storage.transactionSync(() => {
      this.sql("UPDATE machines SET body = ? WHERE id = ?", JSON.stringify(updated), machine.id);
      this.insertRevision(actor, summary, [], null);
      also();
    });
    this.load();
    this.broadcast();
  }

  private async machineMessage(
    socket: WebSocket,
    attachment: Extract<Attachment, { kind: "machine" }>,
    text: string,
  ) {
    const machine = this.state.machines.get(attachment.machineId);
    if (!machine) return;
    let message: DaemonMessage | null;
    try {
      message = JSON.parse(text) as DaemonMessage;
    } catch {
      message = null;
    }
    if (isRecord(message) && message.type === "answer")
      return this.answerChallenge(socket, attachment, machine, message);
    // K-1704: until the check passes, kitshn reads nothing else from the socket.
    if (attachment.check === "waiting")
      return this.refuseSocket(
        socket,
        machine,
        "The daemon sent a message before it answered the challenge.",
      );
    if (!isRecord(message)) return;
    // K-1708: a connection on the token alone only reports; it changes no site, volume or job.
    if (attachment.check === "token" && message.type !== "status" && message.type !== "sample") return;
    if (message.type === "rotate") return this.rotateKey(socket, attachment, machine, message);
    if (message.type === "status" && isRecord(message.status)) {
      const status: MachineStatus = {
        version: String(message.status.version).slice(0, 40),
        os: String(message.status.os).slice(0, 80),
        arch: String(message.status.arch).slice(0, 20),
        hostname: String(message.status.hostname).slice(0, 80),
        capabilities: Array.isArray(message.status.capabilities)
          ? message.status.capabilities
              .filter((item): item is string => typeof item === "string")
              .slice(0, 20)
          : [],
        tunnel: ["starting", "running", "stopped"].includes(String(message.status.tunnel))
          ? message.status.tunnel
          : "stopped",
        ...(typeof message.status.keptBytes === "number" &&
        Number.isSafeInteger(message.status.keptBytes) &&
        message.status.keptBytes >= 0
          ? { keptBytes: message.status.keptBytes }
          : {}),
      };
      socket.serializeAttachment({ ...attachment, status } satisfies Attachment);
      this.setMachineOs(machine.id, machineOs(status.os));
      this.sendMachine(machine);
      // An update job waits for the status; it can go now.
      this.deliverJobs();
    } else if (message.type === "sample" && isRecord(message.sample)) {
      const share = (value: unknown) => (typeof value === "number" && value >= 0 && value <= 1 ? value : 0);
      const sample: Sample = {
        at: Date.now(),
        cpu: share(message.sample.cpu),
        memory: share(message.sample.memory),
        disk: share(message.sample.disk),
      };
      socket.serializeAttachment({ ...attachment, sample } satisfies Attachment);
      this.sendMachine(machine);
    } else if (message.type === "sites") {
      this.updateLiveSites(machine, message.sites);
    } else if (message.type === "icon") {
      await this.liveIcon(machine, message.site, message.icon);
    } else if (message.type === "volumes" && Array.isArray(message.volumes)) {
      const volumes = message.volumes
        .filter(
          (item) => isRecord(item) && typeof item["name"] === "string" && typeof item["project"] === "string",
        )
        .slice(0, 200)
        .map((item): ProjectVolume => ({
          name: item.name.slice(0, 255),
          project: item.project.slice(0, 63),
        }));
      socket.serializeAttachment({ ...attachment, volumes } satisfies Attachment);
      this.sendMachine(machine);
    } else if (message.type === "jobResult" && typeof message.id === "number" && isRecord(message.result)) {
      const result = message.result;
      this.sql(
        // A job failed only because the connection dropped still takes its real result.
        `UPDATE jobs SET state = ?, exit_code = ?, output = ? WHERE id = ? AND machine_id = ?
         AND (state = 'sent' OR (state = 'failed' AND output = '${OFFLINE_OUTPUT}'))`,
        result.ok === true ? "done" : "failed",
        typeof result.exitCode === "number" ? result.exitCode : null,
        // The end of the output holds the error of a failed build.
        String(result.output ?? "").slice(-OUTPUT_LIMIT),
        message.id,
        attachment.machineId,
      );
      // Only a result that this machine's job took counts; a stray or late one changes no deploy.
      const [{ taken } = { taken: 0 }] = this.sql<{ taken: number }>("SELECT changes() AS taken");
      // K-812: the source and params of a Compose deploy live only as long as its job.
      const [job] = taken
        ? this.sql<{ command: string; actor: string }>(
            "SELECT command, actor FROM jobs WHERE id = ?",
            message.id,
          )
        : [];
      const command = job ? (JSON.parse(job.command) as Command) : null;
      // K-909: undo never brings a deleted volume back, so History records the delete as an action once it ran.
      if (job && command?.kind === "compose-volume-remove" && result.ok === true) {
        this.insertRevision(
          JSON.parse(job.actor) as Actor,
          `Deleted the volume ${command.volume} on ${machine.name} (K-909)`,
          [],
          null,
        );
        this.load();
      }
      if (command?.kind === "compose" || command?.kind === "compose-rollback") {
        // K-820: a build that came up clears the give-up note of the CLI; a failed one keeps the machine's error.
        const error = jobError(String(result.output ?? ""));
        this.sql(
          "UPDATE deploys SET state = ?, reason = ?, images = ? WHERE job_id = ? AND state = 'running'",
          result.ok === true ? "done" : "failed",
          result.ok === true ? null : error,
          result.ok === true ? keptImages(result["images"]) : null,
          message.id,
        );
        if (command.kind === "compose-rollback" && command.group)
          this.continueRollback(command.group, result.ok === true ? null : error);
      }
      if (command?.kind === "compose" && this.env.BUCKET) {
        void this.env.BUCKET.delete([
          deployObject(command.deployId, "source.tgz"),
          deployObject(command.deployId, "params.env"),
        ]);
      }
      this.broadcast();
    }
  }

  /** K-602: a new machine gets a service token, a tunnel and a one-time join code. */
  private async addMachine(caller: Caller, body: unknown, origin: string) {
    const api = this.api();
    if (!api) return Response.json({ error: "kitshn has no Cloudflare API token here." }, { status: 503 });
    const input = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const name = typeof input["name"] === "string" ? input["name"].trim() : "";
    if (!name || name.length > 60)
      return Response.json({ error: "Give the machine a name of 1 to 60 characters." }, { status: 400 });
    const labels = parseLabels(input["labels"] ?? []);
    if (typeof labels === "string") return Response.json({ error: labels }, { status: 400 });
    const id = machineIdFor(name);
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    let token: { id: string; client_id: string; client_secret: string } | null = null;
    let tunnel: { id: string } | null = null;
    try {
      const madeToken = await api<{ id: string; client_id: string; client_secret: string }>(
        "POST",
        `${account}/access/service_tokens`,
        { name: `kitshn machine ${id}`, duration: "forever" },
      );
      token = madeToken;
      const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
      const madeTunnel = await api<{ id: string }>("POST", `${account}/cfd_tunnel`, {
        name: `kitshn ${id}`,
        config_src: "cloudflare",
        tunnel_secret: secret,
      });
      tunnel = madeTunnel;
      const tunnelToken = await api<string>("GET", `${account}/cfd_tunnel/${madeTunnel.id}/token`);
      const machine: Machine = {
        id,
        name,
        labels,
        order: Math.max(0, ...[...this.state.machines.values()].map((item) => item.order + 1)),
        serviceTokenId: madeToken.id,
        clientId: madeToken.client_id,
        tunnelId: madeTunnel.id,
        // K-1703: the key comes with the join code, so this machine never connects without one.
        key: { kind: "waiting", since: Date.now() },
      };
      const code = newJoinCode();
      const box = await sealJoin(code, {
        server: origin,
        machineId: id,
        clientId: madeToken.client_id,
        clientSecret: madeToken.client_secret,
        tunnelToken,
      });
      const expiresAt = Date.now() + JOIN_CODE_MS;
      const lookup = await joinLookup(code);
      const resource: Resource = {
        id,
        kind: "machine",
        name,
        addresses: [],
        status: "unknown",
        group: null,
        machine: id,
      };
      this.ctx.storage.transactionSync(() => {
        this.sql("INSERT INTO machines (id, body) VALUES (?, ?)", id, JSON.stringify(machine));
        this.putResource(resource);
        this.sql(
          "INSERT INTO join_codes (lookup, machine_id, iv, sealed, expires_at) VALUES (?, ?, ?, ?, ?)",
          lookup,
          id,
          box.iv,
          box.sealed,
          expiresAt,
        );
        this.insertRevision(caller.actor, `Added machine ${name}`, [], null);
      });
      this.load();
      this.broadcast();
      void this.scheduleAlarm();
      return Response.json({
        machineId: id,
        code,
        expiresAt,
        command: `curl -fsSL ${origin}/join | sh -s -- ${code} ${origin}`,
      });
    } catch (error) {
      // Leave nothing half made behind.
      if (tunnel) await api("DELETE", `${account}/cfd_tunnel/${tunnel.id}`).catch(() => undefined);
      if (token) await api("DELETE", `${account}/access/service_tokens/${token.id}`).catch(() => undefined);
      return Response.json({ error: String(error) }, { status: 502 });
    }
  }

  /**
   * K-602: trades a join code, once and within 10 minutes, for the sealed machine secrets. K-1703: it stores the
   * public half of the machine key in the same step.
   */
  private async exchangeJoin(request: Request) {
    const body = (await request.json().catch(() => null)) as { code?: unknown; publicKey?: unknown } | null;
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!code) return Response.json({ error: "Send the join code." }, { status: 400 });
    // Before the code is used, so the join works again with a daemon of this kitshn.
    const publicKey = parsePublicKey(body?.publicKey);
    if (publicKey === null)
      return Response.json(
        { error: "This daemon sends no machine key. Run the join command of this kitshn again (K-1703)." },
        { status: 400 },
      );
    const key = await this.publicKey(publicKey);
    const lookup = await joinLookup(code);
    const [row] = this.sql<{ machine_id: string; iv: string; sealed: string; expires_at: number }>(
      "SELECT machine_id, iv, sealed, expires_at FROM join_codes WHERE lookup = ?",
      lookup,
    );
    if (!row)
      return Response.json(
        { error: "This join code is not valid, or someone used it already." },
        { status: 404 },
      );
    const machine = this.state.machines.get(row.machine_id);
    const used = () => this.sql("DELETE FROM join_codes WHERE lookup = ?", lookup);
    if (row.expires_at < Date.now() || !machine) {
      used();
      return Response.json(
        {
          error: machine
            ? "This join code expired. Make a new one with Add machine."
            : "The machine of this join code is gone.",
        },
        { status: machine ? 410 : 404 },
      );
    }
    // K-1703: the key and the use of the code are one step.
    this.setKey(
      machine,
      key,
      deviceActor(machine),
      `${machine.name} joined with the key ${key.fingerprint}`,
      used,
    );
    return Response.json({ iv: row.iv, sealed: row.sealed });
  }

  /** K-1706: trades a rekey code, once and within 10 minutes, for a new key of a machine that waits for one. */
  private async rekey(request: Request) {
    const body = (await request.json().catch(() => null)) as {
      code?: unknown;
      publicKey?: unknown;
      machineId?: unknown;
    } | null;
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    const publicKey = parsePublicKey(body?.publicKey);
    const machineId = typeof body?.machineId === "string" ? body.machineId : "";
    if (!code || publicKey === null || !machineId)
      return Response.json(
        { error: "Send the rekey code, the machine id and the public key." },
        { status: 400 },
      );
    const key = await this.publicKey(publicKey);
    const lookup = await joinLookup(code);
    const [row] = this.sql<{ machine_id: string; expires_at: number }>(
      "SELECT machine_id, expires_at FROM rekey_codes WHERE lookup = ?",
      lookup,
    );
    if (!row)
      return Response.json(
        { error: "This rekey code is not valid, or someone used it already." },
        { status: 404 },
      );
    const machine = this.state.machines.get(row.machine_id);
    const used = () => this.sql("DELETE FROM rekey_codes WHERE lookup = ?", lookup);
    const decision = rekeyDecision(
      { machineId: row.machine_id, expiresAt: row.expires_at },
      machineId,
      machine,
      Date.now(),
    );
    if (decision.kind === "refuse") {
      if (!decision.keepCode) used();
      return Response.json({ error: decision.reason }, { status: decision.status });
    }
    if (!machine) throw new Error(`rekeyDecision stored a key for the unknown machine ${row.machine_id}.`);
    // The key and the use of the code are one step, so a failed write keeps the code.
    this.setKey(
      machine,
      key,
      deviceActor(machine),
      `${machine.name} got the key ${key.fingerprint} with a rekey code`,
      used,
    );
    // K-1708: a connection on the token alone ends; the daemon connects again and signs.
    for (const socket of this.ctx.getWebSockets(machine.id))
      socket.close(4001, "This machine has a key now; connect again and sign.");
    return Response.json({ machineId: machine.id, fingerprint: key.fingerprint });
  }

  /** K-1705: "Rotate key" in the panel asks the connected daemon; it hands over to a new key itself. */
  private rotateFromPanel(caller: Caller, id: string) {
    const machine = this.state.machines.get(id);
    if (!machine) return Response.json({ error: `No machine "${id}" exists.` }, { status: 404 });
    if (machine.key?.kind !== "public")
      return Response.json(
        { error: `${machine.name} has no key to rotate. Update its daemon, or use Reset key.` },
        { status: 409 },
      );
    const socket = this.openSocket(id);
    const attachment = socket ? attachmentOf(socket) : null;
    if (!socket || attachment?.kind !== "machine" || attachment.check !== "signed")
      return Response.json({ error: `${machine.name} is offline. Use Reset key instead.` }, { status: 409 });
    socket.serializeAttachment({ ...attachment, rotateBy: caller.actor } satisfies Attachment);
    send(socket, { type: "rotateKey" } satisfies ServerToDaemon);
    return Response.json({ rotating: id });
  }

  /**
   * K-1706: forgets the key at once and closes the machine's sockets. The machine waits for a new key from
   * `kitshn rekey <code>`; until then it cannot connect.
   */
  private async resetKey(caller: Caller, id: string) {
    const machine = this.state.machines.get(id);
    if (!machine) return Response.json({ error: `No machine "${id}" exists.` }, { status: 404 });
    const code = newJoinCode();
    const lookup = await joinLookup(code);
    const expiresAt = Date.now() + JOIN_CODE_MS;
    const newCode = () => {
      this.sql("DELETE FROM rekey_codes WHERE machine_id = ?", id);
      this.sql(
        "INSERT INTO rekey_codes (lookup, machine_id, expires_at) VALUES (?, ?, ?)",
        lookup,
        id,
        expiresAt,
      );
    };
    const answer = Response.json({ machineId: id, code, expiresAt, command: `kitshn rekey ${code}` });
    // K-1708: a machine without a key keeps its status connection until its first key arrives.
    if (machine.key === undefined) {
      this.ctx.storage.transactionSync(() => {
        newCode();
        this.insertRevision(caller.actor, `Made a key code for ${machine.name}`, [], null);
      });
      this.broadcast();
      return answer;
    }
    const old = machine.key.kind === "public" ? ` ${machine.key.fingerprint}` : "";
    this.setKey(
      machine,
      { kind: "waiting", since: Date.now() },
      caller.actor,
      `Reset the key${old} of ${machine.name}`,
      newCode,
    );
    for (const socket of this.ctx.getWebSockets(id))
      socket.close(KEY_RESET, "The owner reset the key of this machine.");
    return answer;
  }

  /** K-615: removes the service token, the tunnel and the queue of a machine. */
  private async removeMachine(caller: Caller, id: string) {
    const machine = this.state.machines.get(id);
    if (!machine) return Response.json({ error: `No machine "${id}" exists.` }, { status: 404 });
    const api = this.api();
    if (!api) return Response.json({ error: "kitshn has no Cloudflare API token here." }, { status: 503 });
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    for (const socket of this.ctx.getWebSockets(id)) socket.close(4002, "The owner removed this machine.");
    const notFound = (error: unknown) =>
      error instanceof CloudflareError && error.status === 404 ? undefined : Promise.reject(error);
    try {
      await api("DELETE", `${account}/access/service_tokens/${machine.serviceTokenId}`).catch(notFound);
      await api("DELETE", `${account}/cfd_tunnel/${machine.tunnelId}/connections`).catch(notFound);
      await api("DELETE", `${account}/cfd_tunnel/${machine.tunnelId}`).catch(notFound);
    } catch (error) {
      return Response.json(
        { error: `kitshn could not remove the machine in Cloudflare: ${String(error)}` },
        { status: 502 },
      );
    }
    this.ctx.storage.transactionSync(() => {
      for (const table of ["machines", "presence"]) this.sql(`DELETE FROM ${table} WHERE id = ?`, id);
      const forgotten = [this.forgetCard(id)];
      this.sql("DELETE FROM jobs WHERE machine_id = ? AND state IN ('queued', 'sent')", id);
      this.sql("DELETE FROM join_codes WHERE machine_id = ?", id);
      this.sql("DELETE FROM rekey_codes WHERE machine_id = ?", id);
      this.sql("DELETE FROM tunnel_objects WHERE machine_id = ?", id);
      for (const site of this.sitesOf(id)) {
        this.sql("DELETE FROM live_sites WHERE id = ?", site.id);
        forgotten.push(this.forgetCard(site.id));
      }
      const key = machine.key?.kind === "public" ? ` and its key ${machine.key.fingerprint}` : "";
      this.insertRevision(caller.actor, `Removed machine ${machine.name}${key}`, forgotten, null);
    });
    this.presence.delete(id);
    this.keyFailures.delete(id);
    this.load();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ removed: id });
  }

  /**
   * K-614, K-718: a sender with the admin needs control on the machine card; any other sender is an agent key
   * and needs the card in its agent circles, checked again when the job goes out.
   */
  private mayRunOn(visitor: Visitor, machineId: string) {
    return this.hasAdmin(visitor)
      ? this.canControl(visitor, machineId)
      : agentMayRunOn(this.state, visitor, machineId, Date.now());
  }

  /** K-614: the sender of a command needs control on the machine card itself, not only on the admin. */
  private canControl(visitor: Visitor, machineId: string) {
    const resource = this.state.resources.get(machineId);
    if (!resource) return false;
    // K-1504, MM-711: the owner keeps the commands they had; the pause takes no tool from them and gives none.
    const state = this.state.paused && this.hasAdmin(visitor) ? { ...this.state, paused: null } : this.state;
    return visitorLevel(state, resource, visitor, Date.now()) === "control";
  }

  /** K-610 to K-614: a job runs on one machine, or on the first online machine with its labels. */
  private addJob(caller: Caller, body: unknown) {
    const input = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const parsed = parseCommand(input["command"]);
    if (typeof parsed === "string") return Response.json({ error: parsed }, { status: 400 });
    if (parsed.kind === "update" && !/^[0-9a-f]{12}$/.test(this.env.KITSHN_VERSION)) {
      return Response.json(
        {
          error: `This kitshn runs the build "${this.env.KITSHN_VERSION}", which has no release to update to.`,
        },
        { status: 409 },
      );
    }
    const labels = parseLabels(input["labels"] ?? []);
    if (typeof labels === "string") return Response.json({ error: labels }, { status: 400 });
    const machineId = typeof input["machineId"] === "string" ? input["machineId"] : null;
    const target = machineId === null ? null : this.state.machines.get(machineId);
    if (machineId !== null && !target) {
      return Response.json({ error: `No machine "${machineId}" exists.` }, { status: 404 });
    }
    // K-909: only a volume that the machine reports as orphaned, with the project from that report.
    const orphan =
      parsed.kind === "compose-volume-remove"
        ? (target ? this.machineView(target).orphanVolumes : []).find(
            (volume) => volume.name === parsed.volume,
          )
        : undefined;
    if (parsed.kind === "compose-volume-remove" && !orphan)
      return Response.json(
        { error: `${parsed.volume} is not an orphaned volume of this machine (K-909).` },
        { status: 409 },
      );
    const command: Command =
      parsed.kind === "update"
        ? { kind: "update", version: this.env.KITSHN_VERSION }
        : parsed.kind === "compose-volume-remove" && orphan
          ? { ...parsed, project: orphan.project }
          : parsed;
    if (machineId !== null && !this.canControl(caller.visitor, machineId)) {
      return Response.json(
        {
          error:
            "Commands need the control level on the machine. Put its card in a circle that gives you control.",
        },
        { status: 403 },
      );
    }
    if (machineId === null && labels.length === 0) {
      return Response.json({ error: "A job needs a machine or labels." }, { status: 400 });
    }
    const now = Date.now();
    const [row] = this.ctx.storage.transactionSync(() => {
      const inserted = this.sql<{ id: number }>(
        `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, exit_code, output)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, NULL, '') RETURNING id`,
        machineId,
        JSON.stringify(labels),
        JSON.stringify(command),
        now,
        now + JOB_EXPIRY_MS,
        JSON.stringify(caller.actor),
        JSON.stringify(caller.visitor),
      );
      // K-614: the history names the member that sent a shell command.
      if (command.kind === "shell") {
        const where = target ? target.name : `a machine with ${labels.join(", ")}`;
        this.insertRevision(caller.actor, `Ran on ${where}: ${command.script.slice(0, 80)}`, [], null);
      }
      return inserted;
    });
    if (command.kind === "shell") this.load();
    this.deliverJobs();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ id: row?.id ?? null });
  }

  /**
   * Sends each queued job to its machine when that machine is online (K-613 "when online"). A label job
   * goes to the first fitting machine in the order on which its sender has control (K-610, K-614).
   */
  private deliverJobs() {
    const online = this.jobMachines();
    const queued = this.sql<{
      id: number;
      machine_id: string | null;
      labels: string;
      command: string;
      visitor: string;
    }>(
      "SELECT id, machine_id, labels, command, visitor FROM jobs WHERE state = 'queued' AND expires_at > ? ORDER BY id",
      Date.now(),
    );
    for (const job of queued) {
      const visitor = JSON.parse(job.visitor) as Visitor & { readonly kitshn?: true };
      const queuedCommand = JSON.parse(job.command) as Command;
      // K-718: a redeploy that an agent key asked for goes out only while every check of its start still holds.
      if (visitor.kitshn && visitor.clientId !== null) {
        const reason =
          queuedCommand.kind !== "compose-redeploy"
            ? "kitshn makes no other job for an agent key."
            : !cardsControlledBy(this.state, visitor, Date.now()).has(queuedCommand.project)
              ? "The key no longer manages the card."
              : (this.redeployRefusal(job.machine_id, queuedCommand.project) ??
                this.repoRefusal(this.repoIdOfCard(queuedCommand.project)));
        if (reason !== null) {
          this.sql("UPDATE jobs SET state = 'failed', output = ? WHERE id = ?", reason, job.id);
          continue;
        }
      }
      // A job that kitshn makes itself (a deploy) needs no member with control (K-614).
      const allowed = new Set(
        visitor.kitshn ? online : [...online].filter((id) => this.mayRunOn(visitor, id)),
      );
      const machine =
        job.machine_id !== null
          ? allowed.has(job.machine_id)
            ? (this.state.machines.get(job.machine_id) ?? null)
            : null
          : pickMachine(this.state.machines.values(), allowed, JSON.parse(job.labels) as Array<string>);
      if (!machine) continue;
      const socket = this.openSocket(machine.id);
      if (!socket) continue;
      let command = JSON.parse(job.command) as Command;
      if (command.kind === "compose-volume-remove" && this.state.resources.has(command.project)) {
        this.sql(
          "UPDATE jobs SET state = 'failed', output = ? WHERE id = ?",
          "The app of this volume has a card again, so the volume is no longer orphaned (K-909).",
          job.id,
        );
        continue;
      }
      if (command.kind === "update") {
        // K-617: the version at delivery, so a job that waited never installs an older release.
        command = { kind: "update", version: this.env.KITSHN_VERSION };
        const status = this.machineView(machine).status;
        // The daemon sends its status just after it connects; the job waits for it.
        if (!status) continue;
        const fail = (output: string) =>
          this.sql("UPDATE jobs SET state = 'failed', output = ? WHERE id = ?", output, job.id);
        if (!/^[0-9a-f]{12}$/.test(command.version)) {
          fail(`This kitshn runs the build "${command.version}", which has no release to update to.`);
          continue;
        }
        // A daemon from before the gzipped release files updates with the shell script, which unpacks them.
        if (!status.capabilities?.includes("update-gz")) {
          const script =
            status.version === "dev" ? null : legacyUpdateScript(command.version, status.os, status.arch);
          if (!script) {
            fail(
              "This daemon runs from source, or kitshn does not know its platform. Update it by hand or join the machine again.",
            );
            continue;
          }
          command = { kind: "shell", script };
        }
      }
      send(socket, { type: "job", id: job.id, command });
      this.sql("UPDATE jobs SET state = 'sent', machine_id = ? WHERE id = ?", machine.id, job.id);
    }
  }

  /** K-609: the owner sets the labels and the order of a machine. */
  private updateMachine(caller: Caller, id: string, body: unknown) {
    const machine = this.state.machines.get(id);
    if (!machine) return Response.json({ error: `No machine "${id}" exists.` }, { status: 404 });
    const input = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const labels = input["labels"] === undefined ? machine.labels : parseLabels(input["labels"]);
    if (typeof labels === "string") return Response.json({ error: labels }, { status: 400 });
    const order = input["order"] === undefined ? machine.order : Number(input["order"]);
    if (!Number.isInteger(order) || order < 0 || order > 10_000) {
      return Response.json({ error: "The order is a whole number from 0 to 10,000." }, { status: 400 });
    }
    const allow = input["allow"] === undefined ? (machine.allow ?? []) : parseAllowances(input["allow"]);
    if (typeof allow === "string") return Response.json({ error: allow }, { status: 400 });
    const updated: Machine = { ...machine, labels: [...labels], order, allow };
    if (deepEqual(updated, machine)) return Response.json(updated);
    this.ctx.storage.transactionSync(() => {
      this.sql("UPDATE machines SET body = ? WHERE id = ?", JSON.stringify(updated), id);
      this.insertRevision(
        caller.actor,
        `Changed machine ${machine.name}: labels ${labels.join(", ") || "none"}, order ${order}, ${allow.length} allowed Compose settings`,
        [],
        null,
      );
    });
    this.load();
    this.deliverJobs();
    this.broadcast();
    return Response.json(updated);
  }

  private recentJobs(limit: number, outputLimit = 4000, id: number | null = null): Array<Job> {
    return this.sql<{
      id: number;
      machine_id: string | null;
      labels: string;
      command: string;
      state: Job["state"];
      created_at: number;
      expires_at: number;
      actor: string;
      exit_code: number | null;
      output: string;
    }>(
      "SELECT id, machine_id, labels, command, state, created_at, expires_at, actor, exit_code, output FROM jobs WHERE ? IS NULL OR id = ? ORDER BY id DESC LIMIT ?",
      id,
      id,
      limit,
    ).map((row) => ({
      id: row.id,
      machineId: row.machine_id,
      labels: JSON.parse(row.labels) as Array<string>,
      command: JSON.parse(row.command) as Command,
      state: row.state,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      actor: row.actor,
      exitCode: row.exit_code,
      output: row.output.slice(0, outputLimit),
    }));
  }

  /** K-1107: closes machine sockets that answered no ping for 30 seconds. K-1704: and those without an answer. */
  private checkLiveness(now: number) {
    for (const socket of this.ctx.getWebSockets("machines")) {
      const attachment = attachmentOf(socket);
      if (attachment?.kind !== "machine") continue;
      const machine = this.state.machines.get(attachment.machineId);
      if (machine && attachment.check === "waiting" && now - attachment.since >= CHALLENGE_MS) {
        this.refuseSocket(socket, machine, "No answer to the challenge within 10 seconds.");
        continue;
      }
      const last = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? attachment.since;
      if (now - last > PING_TIMEOUT_MS) {
        socket.close(4008, "No ping for 30 seconds.");
        this.socketGone(socket);
      }
    }
  }

  /** Returns how many jobs expired. */
  private expireJobs(now: number) {
    return this.sql(
      "UPDATE jobs SET state = 'expired' WHERE state IN ('queued', 'sent') AND expires_at <= ? RETURNING id",
      now,
    ).length;
  }

  /**
   * K-603: kitshn owns each tunnel's ingress and writes it from the alarm queue. A site gets ingress only
   * once its Access application exists (K-410). A row keeps the ingress that Cloudflare last accepted;
   * a failed write tries again after five minutes.
   */
  private async syncTunnels(api: NonNullable<ReturnType<Kitshn["api"]>>, budget: number) {
    let calls = 0;
    const now = Date.now();
    const rows = new Map(this.tunnelRows().map((row) => [row.machine_id, row]));
    const accessOf = this.ingressAccessOf();
    for (const machine of this.state.machines.values()) {
      const row = rows.get(machine.id);
      if (row?.error && row.retry_at > now) continue;
      const config = tunnelConfig(this.protectedSites(machine.id), accessOf);
      const body = JSON.stringify(config);
      if (row?.applied === body && row.error === null) continue;
      if (calls++ >= budget) return;
      for (const site of this.protectedSites(machine.id)) {
        const access = accessOf(site);
        if (access.kind === "pending")
          console.warn(
            `kitshn writes the ingress of ${site.address} without the Access check: ${access.reason}.`,
          );
      }
      try {
        await api(
          "PUT",
          `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${machine.tunnelId}/configurations`,
          config,
        );
        this.sql(
          "INSERT OR REPLACE INTO tunnel_objects (machine_id, body, applied, error, retry_at) VALUES (?, ?, ?, NULL, 0)",
          machine.id,
          body,
          body,
        );
      } catch (error) {
        this.sql(
          "INSERT OR REPLACE INTO tunnel_objects (machine_id, body, applied, error, retry_at) VALUES (?, ?, ?, ?, ?)",
          machine.id,
          body,
          row?.applied ?? "",
          String(error),
          now + RETRY_MS,
        );
      }
    }
  }

  private tunnelRows() {
    return this.sql<{
      machine_id: string;
      body: string;
      applied: string;
      error: string | null;
      retry_at: number;
    }>("SELECT machine_id, body, applied, error, retry_at FROM tunnel_objects");
  }

  /**
   * K-006: every address that a route can still reach: tunnel ingress that Cloudflare accepted, a DNS
   * record or an offline route that kitshn made. Its Access application stays until none is left.
   */
  private reachableAddresses() {
    return reachableAddresses({
      ingress: this.tunnelRows().map((row) => row.applied),
      records: this.sql<{ address: string; record_id: string }>("SELECT address, record_id FROM dns_objects"),
      routes: this.sql<{ address: string; route_id: string }>("SELECT address, route_id FROM route_objects"),
    });
  }

  /** True when a site check, a tunnel, a DNS record or an offline route waits for the alarm. */
  private tunnelWork() {
    const now = Date.now();
    const tunnels = new Map(this.tunnelRows().map((row) => [row.machine_id, row]));
    const accessOf = this.ingressAccessOf();
    const stale = [...this.state.machines.values()].some((machine) => {
      const row = tunnels.get(machine.id);
      if (row?.error && row.retry_at > now) return false;
      return row?.applied !== JSON.stringify(tunnelConfig(this.protectedSites(machine.id), accessOf));
    });
    const checking = [...this.liveSites.values()].some(
      (site) => site.state === "checking" && (this.checkRetryAt.get(site.id) ?? 0) <= Date.now(),
    );
    return stale || checking || this.dnsWork().length > 0 || this.routeWork().length > 0;
  }

  /**
   * Deletes a card's rows and takes it out of its stack, inside the caller's transaction (K-522). Returns the
   * mark that the revision of the deletion stores, so an older undo never touches a new card of the same id (K-1506).
   */
  private forgetCard(id: string): Forget {
    for (const table of ["resources", "places"]) this.sql(`DELETE FROM ${table} WHERE id = ?`, id);
    this.sql("DELETE FROM share_settings WHERE id LIKE ?", `${id}/%`);
    const stacks = this.sql<{ id: string; body: string }>("SELECT id, body FROM stacks").map(
      (row) => JSON.parse(row.body) as Stack,
    );
    for (const change of stacksWithout(stacks, id)) {
      if (change.after)
        this.sql("UPDATE stacks SET body = ? WHERE id = ?", JSON.stringify(change.after), change.id);
      else this.sql("DELETE FROM stacks WHERE id = ?", change.id);
    }
    return { _tag: "forget", id, before: null, after: null };
  }

  private sitesOf(machineId: string) {
    return [...this.liveSites.values()].filter((site) => site.machineId === machineId);
  }

  /** K-603: the Access check of each ingress rule, from the Access objects that Cloudflare accepted. */
  private ingressAccessOf() {
    return (site: LiveSite) => ingressAccess(site, this.access, this.env.ACCESS_TEAM_DOMAIN);
  }

  /** Live sites whose address is checked and whose Access application exists in Cloudflare. */
  private protectedSites(machineId?: string) {
    return protectedLiveSites(
      [...this.liveSites.values()].filter((site) => machineId === undefined || site.machineId === machineId),
      (id) => this.state.resources.get(id),
      // The application exists in Cloudflare; a later failed update of it does not take the site down.
      (site) => Boolean(this.access.get(`app:${site.id}:${site.address}`)?.cfId),
    );
  }

  /**
   * K-1104: takes the full list of live sites of one machine. A new site waits for an address check
   * (K-1111, K-408) before it becomes a card in the tray (K-509).
   */
  private updateLiveSites(machine: Machine, reported: unknown) {
    const { sites, refused } = parseSites(reported);
    const now = Date.now();
    const keep = new Set<string>();
    let changed = false;
    this.ctx.storage.transactionSync(() => {
      for (const report of sites) {
        const address = `${report.name}.${this.env.KITSHN_ZONE}`;
        // K-812: the socket of a Compose app on this machine is the address of its card.
        const app = [...this.state.resources.values()].find(
          (resource) =>
            resource.kind === "site.compose" &&
            resource.machine === machine.id &&
            resource.addresses.includes(address),
        );
        // K-909: a removed Compose app keeps its row until its compose-down ends, so it never turns into a
        // live site card meanwhile.
        const id =
          app?.id ??
          this.sitesOf(machine.id).find((site) => site.address === address)?.id ??
          liveSiteId(machine.id, report.name);
        const other = [...this.state.resources.values()].find(
          (resource) => resource.id !== id && resource.addresses.includes(address),
        );
        const otherSite = [...this.liveSites.values()].find(
          (site) => site.id !== id && site.address === address,
        );
        if (other || otherSite) {
          refused.push(`${address} belongs to ${other ? `the card ${other.name}` : "another machine"}.`);
          continue;
        }
        keep.add(id);
        const old = this.liveSites.get(id);
        if (old && old.target === report.target && old.dev === report.dev && old.up === report.up) continue;
        changed = true;
        // lastUp records the moment a site was last seen up, so it changes when the site goes down.
        const lastUp = report.up || !old ? now : old.up ? now : old.lastUp;
        this.sql(
          `INSERT OR REPLACE INTO live_sites (id, machine_id, name, address, target, dev, up, last_up, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          machine.id,
          report.name,
          address,
          report.target,
          report.dev ? 1 : 0,
          report.up ? 1 : 0,
          lastUp,
          old?.state ?? "checking",
        );
        const resource = this.state.resources.get(id);
        if (resource) this.putResource({ ...resource, status: report.up ? "running" : "stopped" });
      }
      for (const site of this.sitesOf(machine.id)) {
        if (keep.has(site.id)) continue;
        changed = true;
        this.sql("DELETE FROM live_sites WHERE id = ?", site.id);
        // A removed app has its History entry already (K-909).
        const hadCard = this.state.resources.has(site.id);
        const forgotten = this.forgetCard(site.id);
        if (hadCard)
          this.insertRevision(
            { _tag: "kitshn", reason: `live site on ${machine.name}` },
            `${machine.name} stopped exposing ${site.address}`,
            [forgotten],
            null,
          );
      }
    });
    for (const reason of refused) console.warn(`kitshn refused a live site of ${machine.name}: ${reason}`);
    if (!changed) return;
    this.load();
    this.broadcast();
    void this.scheduleAlarm();
  }

  /**
   * K-1111, K-408: a new live site gets its card only when nothing else uses its address: no DNS record
   * and no Worker custom domain. Otherwise kitshn refuses it and makes nothing for it.
   */
  private async checkSites(api: Api, budget: number) {
    let calls = 0;
    let changed = false;
    const ours = new Set(
      this.sql<{ record_id: string }>("SELECT record_id FROM dns_objects").map((row) => row.record_id),
    );
    for (const site of [...this.liveSites.values()].filter((item) => item.state === "checking")) {
      if ((this.checkRetryAt.get(site.id) ?? 0) > Date.now()) continue;
      if (calls + 2 > budget) break;
      calls += 2;
      let used: boolean;
      try {
        const records = await api<Array<{ id: string }>>(
          "GET",
          `/zones/${this.env.CLOUDFLARE_ZONE_ID}/dns_records?name=${encodeURIComponent(site.address)}`,
        );
        const domains = await api<Array<unknown>>(
          "GET",
          `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/domains?hostname=${encodeURIComponent(site.address)}`,
        );
        // A record that kitshn made itself (for a site that moved) does not count.
        used = records.some((record) => !ours.has(record.id)) || domains.length > 0;
      } catch (error) {
        // Try again in five minutes; the rest of the alarm run goes on.
        this.checkRetryAt.set(site.id, Date.now() + 5 * 60_000);
        console.warn(`kitshn could not check ${site.address}: ${String(error)}`);
        continue;
      }
      this.checkRetryAt.delete(site.id);
      // The site may have changed while the checks waited; act only on the row as it is now.
      const [row] = this.sql<{ state: string }>("SELECT state FROM live_sites WHERE id = ?", site.id);
      if (row?.state !== "checking") continue;
      changed = true;
      if (used) {
        this.sql("UPDATE live_sites SET state = 'refused' WHERE id = ?", site.id);
        console.warn(`kitshn refused ${site.address}: something else already uses the address.`);
        continue;
      }
      const machine = this.state.machines.get(site.machineId);
      this.ctx.storage.transactionSync(() => {
        this.sql("UPDATE live_sites SET state = 'ok' WHERE id = ?", site.id);
        const card = this.state.resources.get(site.id);
        this.putResource(
          card
            ? { ...card, status: site.up ? "running" : "stopped" }
            : {
                id: site.id,
                kind: "site.live",
                name: site.name,
                addresses: [site.address],
                status: site.up ? "running" : "stopped",
                group: null,
                machine: site.machineId,
              },
        );
        this.insertRevision(
          { _tag: "kitshn", reason: `live site on ${machine?.name ?? site.machineId}` },
          `${machine?.name ?? site.machineId} exposed ${site.address} (K-1104)`,
          [],
          null,
        );
      });
    }
    if (changed) {
      this.load();
      this.broadcast();
    }
    return calls;
  }

  /**
   * Live site addresses whose DNS record kitshn still has to make, point elsewhere, or delete. A record
   * goes only after the ingress and the offline route of its address are gone (K-410).
   */
  private dnsWork() {
    const now = Date.now();
    const rows = new Map(
      this.sql<{
        address: string;
        record_id: string;
        content: string;
        card_id: string | null;
        error: string | null;
        retry_at: number;
      }>("SELECT * FROM dns_objects").map((row) => [row.address, row]),
    );
    const due = (address: string) => {
      const row = rows.get(address);
      return !row?.error || row.retry_at <= now;
    };
    const wanted = new Map(
      this.protectedSites().flatMap((site) => {
        const machine = this.state.machines.get(site.machineId);
        return machine
          ? [[site.address, { content: `${machine.tunnelId}.cfargotunnel.com`, cardId: site.id }] as const]
          : [];
      }),
    );
    const routed = reachableAddresses({
      ingress: this.tunnelRows().map((row) => row.applied),
      records: [],
      routes: this.sql<{ address: string; route_id: string }>("SELECT address, route_id FROM route_objects"),
    });
    return [
      ...[...wanted]
        .filter(([address, { content, cardId }]) => {
          const row = rows.get(address);
          // An older row without its card gets the card at the next write (K-817).
          return (
            due(address) && (!row || row.error !== null || row.content !== content || row.card_id !== cardId)
          );
        })
        .map(([address, { content, cardId }]) => ({ address, content: content as string | null, cardId })),
      ...[...rows.values()]
        .filter((row) => !wanted.has(row.address) && due(row.address) && !routed.has(row.address))
        .map((row) => ({ address: row.address, content: null, cardId: row.card_id })),
    ];
  }

  /** K-1108: addresses whose offline route kitshn still has to add or remove. */
  private routeWork() {
    const now = Date.now();
    const rows = new Map(
      this.sql<{ address: string; route_id: string; error: string | null; retry_at: number }>(
        "SELECT * FROM route_objects",
      )
        .filter((row) => row.error === null || row.retry_at <= now)
        .map((row) => [row.address, row]),
    );
    const failed = new Set(
      this.sql<{ address: string }>(
        "SELECT address FROM route_objects WHERE error IS NOT NULL AND retry_at > ?",
        now,
      ).map((row) => row.address),
    );
    const wanted = new Set(
      sitesNeedingRoutes(this.protectedSites(), this.onlineMachines()).map((site) => site.address),
    );
    return [
      ...[...wanted]
        .filter((address) => !failed.has(address) && (!rows.has(address) || !rows.get(address)?.route_id))
        .map((address) => ({ address, add: true })),
      ...[...rows.values()]
        .filter((row) => !wanted.has(row.address) && !failed.has(row.address))
        .map((row) => ({ address: row.address, add: false })),
    ];
  }

  /** K-1111, K-817: the API path of the zone of an address. It fails for an address outside every zone. */
  private zonePath(address: string) {
    const zone = zoneOfAddressIn(address, this.env);
    if (!zone) throw new Error(`kitshn does not publish on the zone of ${address} (K-1111).`);
    return `/zones/${zone.id}`;
  }

  /** K-1104: a proxied CNAME per live site to its machine's tunnel. kitshn deletes only records it made. */
  private async syncDns(api: Api, budget: number) {
    let calls = 0;
    for (const work of this.dnsWork()) {
      if (calls >= budget) return;
      calls++;
      const [row] = this.sql<{ record_id: string; card_id: string | null }>(
        "SELECT record_id, card_id FROM dns_objects WHERE address = ?",
        work.address,
      );
      try {
        const zone = `${this.zonePath(work.address)}/dns_records`;
        if (work.content !== null) {
          const body = {
            type: "CNAME",
            name: work.address,
            content: work.content,
            proxied: true,
            comment: "kitshn live site (K-1104)",
          };
          const record = row?.record_id
            ? await api<{ id: string }>("PUT", `${zone}/${row.record_id}`, body)
            : await api<{ id: string }>("POST", zone, body);
          this.sql(
            "INSERT OR REPLACE INTO dns_objects (address, record_id, content, error, retry_at, card_id) VALUES (?, ?, ?, NULL, 0, ?)",
            work.address,
            record.id,
            work.content,
            work.cardId,
          );
        } else {
          if (row?.record_id) {
            await api("DELETE", `${zone}/${row.record_id}`).catch((error: unknown) =>
              error instanceof CloudflareError && error.status === 404 ? undefined : Promise.reject(error),
            );
          }
          this.sql("DELETE FROM dns_objects WHERE address = ?", work.address);
        }
      } catch (error) {
        this.sql(
          "INSERT OR REPLACE INTO dns_objects (address, record_id, content, error, retry_at, card_id) VALUES (?, ?, ?, ?, ?, ?)",
          work.address,
          row?.record_id ?? "",
          work.content ?? "",
          String(error),
          Date.now() + RETRY_MS,
          row?.card_id ?? work.cardId,
        );
      }
    }
  }

  /** K-1108: a Worker route on a live site only while its origin is down, so healthy visits cost nothing. */
  private async syncRoutes(api: Api, budget: number) {
    let calls = 0;
    // A route that failed to go but is wanted again simply stays; its old error no longer applies.
    for (const site of sitesNeedingRoutes(this.protectedSites(), this.onlineMachines())) {
      this.sql(
        "UPDATE route_objects SET error = NULL, retry_at = 0 WHERE address = ? AND route_id != '' AND error IS NOT NULL",
        site.address,
      );
    }
    for (const work of this.routeWork()) {
      if (calls++ >= budget) return;
      try {
        const routes = `${this.zonePath(work.address)}/workers/routes`;
        if (work.add) {
          const route = await api<{ id: string }>("POST", routes, {
            pattern: `${work.address}/*`,
            script: "kitshn",
          });
          this.sql(
            "INSERT OR REPLACE INTO route_objects (address, route_id, error, retry_at) VALUES (?, ?, NULL, 0)",
            work.address,
            route.id,
          );
        } else {
          const [row] = this.sql<{ route_id: string }>(
            "SELECT route_id FROM route_objects WHERE address = ?",
            work.address,
          );
          if (row?.route_id) {
            await api("DELETE", `${routes}/${row.route_id}`).catch((error: unknown) =>
              error instanceof CloudflareError && error.status === 404 ? undefined : Promise.reject(error),
            );
          }
          this.sql("DELETE FROM route_objects WHERE address = ?", work.address);
        }
      } catch (error) {
        this.sql(
          "INSERT OR REPLACE INTO route_objects (address, route_id, error, retry_at) VALUES (?, COALESCE((SELECT route_id FROM route_objects WHERE address = ?), ''), ?, ?)",
          work.address,
          work.address,
          String(error),
          Date.now() + RETRY_MS,
        );
      }
    }
  }

  /** K-1110: what the offline page of an address shows. */
  private offlineInfo(address: string) {
    // K-817: an extra address of a Compose app shows the offline page of its site too.
    const site = [...this.liveSites.values()]
      .flatMap((item) => servedSites(item, this.state.resources.get(item.id)))
      .find((item) => item.address === address);
    if (!site) return Response.json({ error: "No live site has this address." }, { status: 404 });
    const machine = this.state.machines.get(site.machineId);
    const online = this.onlineMachines().has(site.machineId);
    const seen = online ? site.lastUp : (this.presence.get(site.machineId)?.lastSeen ?? site.lastUp);
    return Response.json({
      site: site.address,
      machine: machine?.name ?? "the machine",
      reason: offlineReason(machine?.name ?? "the machine", online),
      seen,
    });
  }

  /** K-1118: the public app cards with their main address and icon. The Worker caches the answer. */
  private publicCards() {
    const environmentOf = (id: string) => this.lastDone(id)?.environment ?? null;
    const cards = listedApps(this.state, environmentOf, Date.now()).map((resource) => {
      const [icon] = this.sql<{ type: string; bytes: ArrayBuffer }>(
        "SELECT type, bytes FROM icons WHERE id = ?",
        resource.id,
      );
      if (!icon)
        return { name: resource.name, address: resource.addresses[0], kind: resource.kind, icon: null };
      // A spread of 100 KB into String.fromCharCode passes the argument limit, so one byte at a time.
      let binary = "";
      for (const byte of new Uint8Array(icon.bytes)) binary += String.fromCharCode(byte);
      return {
        name: resource.name,
        address: resource.addresses[0],
        kind: resource.kind,
        icon: `data:${icon.type};base64,${btoa(binary)}`,
      };
    });
    return Response.json({ cards });
  }

  /** K-1119: the badge state of the newest deploy of one repo, app and environment. Skipped deploys do not count. */
  private badge(query: URLSearchParams) {
    // The index deploys_badge (migration 20) serves this lookup.
    const [row] = this.sql<{ resource_id: string; state: string; expires_at: number }>(
      `SELECT resource_id, state, expires_at FROM deploys WHERE lower(repo) = lower(?) AND app_key = ? AND environment = ?
       AND kind = 'deploy' AND state != 'skipped' ORDER BY rowid DESC LIMIT 1`,
      query.get("repo") ?? "",
      query.get("app") ?? "app",
      query.get("env") ?? "prod",
    );
    const resource = row ? this.state.resources.get(row.resource_id) : undefined;
    const now = Date.now();
    // A run that stopped before it reported leaves its row planned or running after it expired (as deployRuns reads).
    const state =
      row && row.state !== "done" && row.state !== "failed" && row.expires_at <= now ? "failed" : row?.state;
    return Response.json({ state: badgeState(this.state, resource, state ?? null, now) });
  }

  /** K-1302: one alarm for the next due item. Access work, share end dates, and the daily run. */
  private async scheduleAlarm() {
    const now = Date.now();
    let next = this.dailyAt();
    for (const socket of this.ctx.getWebSockets("machines")) {
      const attachment = attachmentOf(socket);
      next = Math.min(next, now + PING_TIMEOUT_MS);
      // K-1704: a socket without an answer closes after 10 seconds.
      if (attachment?.kind === "machine" && attachment.check === "waiting")
        next = Math.min(next, attachment.since + CHALLENGE_MS);
    }
    if (this.env.CLOUDFLARE_API_TOKEN && this.tunnelWork()) next = now;
    const [job] = this.sql<{ expires_at: number }>(
      "SELECT MIN(expires_at) AS expires_at FROM jobs WHERE state IN ('queued', 'sent')",
    );
    if (job?.expires_at) next = Math.min(next, Math.max(job.expires_at, now));
    const desired = this.desired(now);
    if (
      this.env.CLOUDFLARE_API_TOKEN &&
      (hasAccessWork(
        desired,
        this.access,
        this.reachableAddresses(),
        loginHeld(this.meta("login_held") ?? ""),
      ) ||
        this.launcherWork() ||
        this.loginWork())
    )
      next = now;
    // A failed tunnel, DNS or route write tries again after five minutes (K-410). Only a future retry
    // time counts here; a row that is due counts through tunnelWork, and only when there is work for it.
    const [retry] = this.sql<{ at: number | null }>(
      `SELECT MIN(retry_at) AS at FROM (SELECT retry_at FROM tunnel_objects WHERE error IS NOT NULL
       UNION ALL SELECT retry_at FROM dns_objects WHERE error IS NOT NULL
       UNION ALL SELECT retry_at FROM route_objects WHERE error IS NOT NULL) WHERE retry_at > ?`,
      now,
    );
    if (retry?.at) next = Math.min(next, retry.at);
    if (this.env.CLOUDFLARE_API_TOKEN && rowsWithoutAud(this.access).length > 0)
      next = Math.min(next, Math.max(this.audRetryAt, now));
    const ends = [
      ...[...this.state.shareSettings.values()].map((setting) => setting.endsAt),
      ...[...this.state.circles.values()].map((circle) => circle.endsAt),
    ];
    for (const end of ends) if (end !== null && end > now && end < next) next = end;
    if (ends.some((end) => end !== null && end <= now) && this.expiredShares(now).length > 0) next = now;
    // Never move a pending alarm later: frequent wake-ups would otherwise push it away for good.
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current <= now || next < current) await this.ctx.storage.setAlarm(next);
  }

  private dailyAt() {
    const [row] = this.sql<{ value: string }>("SELECT value FROM meta WHERE key = 'daily_at'");
    if (row) return Number(row.value);
    const at = nextUtcMidnight(Date.now());
    this.sql("INSERT INTO meta (key, value) VALUES ('daily_at', ?)", String(at));
    return at;
  }

  private expiredShares(now: number) {
    return [...this.state.shareSettings.entries()].filter(([id, setting]) => {
      if (setting.endsAt === null || setting.endsAt > now || this.stuckShares.has(id)) return false;
      const [resourceId, circleId] = id.split("/");
      return circlesHolding(this.state, resourceId ?? "").some((circle) => circle.id === circleId);
    });
  }

  /** K-209: at its end date, a share moves its card out of the circle as a new revision. */
  private endShares(now: number) {
    for (const [id, setting] of this.expiredShares(now)) {
      const [resourceId = "", circleId = ""] = id.split("/");
      const from = this.state.places.get(resourceId);
      if (!from) continue;
      const keep = new Set(circlesHolding(this.state, resourceId).map((circle) => circle.id));
      keep.delete(circleId);
      const to = placeInside(this.state, from, keep);
      const circle = this.state.circles.get(circleId);
      try {
        if (!to) throw new RuleError("no place outside the circle keeps the other shares");
        this.commit(
          { _tag: "kitshn", reason: `share with ${circle?.name ?? circleId} ended` },
          resolveEdits(this.state, [
            // K-521: the card leaves its stack, so the rest of the stack stays where it is.
            ...stacksWithout(this.state.stacks.values(), resourceId).map((change): Edit => ({
              _tag: "stack",
              ...change,
            })),
            { _tag: "place", id: resourceId, after: to },
            { _tag: "shareSetting", resourceId, circleId, after: { ...setting, endsAt: null } },
          ]),
          null,
        );
      } catch (error) {
        // The share already gives no access after its end date; only the card stays where it is.
        this.stuckShares.add(id);
        console.warn(`kitshn could not move ${resourceId} out of ${circleId}: ${String(error)}`);
      }
    }
  }

  private daily(now: number) {
    this.ctx.storage.transactionSync(() => {
      this.sql(
        `DELETE FROM revisions WHERE at < ? OR id <= (SELECT id FROM revisions ORDER BY id DESC LIMIT 1 OFFSET ?)`,
        now - REVISION_DAYS * DAY,
        REVISION_COUNT,
      );
      // K-408: retry what failed once a day.
      this.sql("UPDATE access_objects SET error = NULL WHERE error IS NOT NULL");
      this.sql("DELETE FROM meta WHERE key = 'launcher_failed'");
      this.sql("DELETE FROM meta WHERE key = 'login_failed'");
      this.sql("INSERT OR REPLACE INTO meta (key, value) VALUES ('login_check', 'due')");
      // A refused address may be free now, for example after the other machine let it go.
      this.sql("UPDATE live_sites SET state = 'checking' WHERE state = 'refused'");
      // K-1503 style clean-up: keep the newest 1,000 finished jobs.
      this.sql(
        "DELETE FROM jobs WHERE state NOT IN ('queued', 'sent') AND id <= (SELECT id FROM jobs ORDER BY id DESC LIMIT 1 OFFSET 1000)",
      );
      this.sql("DELETE FROM join_codes WHERE expires_at < ?", now);
      this.sql("DELETE FROM rekey_codes WHERE expires_at < ?", now);
      // K-1113: a removed card keeps its icon until this run, so a quick Undo keeps it; a deploy sends it again.
      for (const { id } of this.sql<{ id: string }>(
        "DELETE FROM icons WHERE id NOT IN (SELECT id FROM resources) RETURNING id",
      )) {
        // The same id can get a card again (K-1114), so memory forgets the icon too.
        this.iconHashes.delete(id);
        this.iconChangedAt.delete(id);
      }
      this.sql(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('daily_at', ?)",
        String(nextUtcMidnight(now)),
      );
    });
    for (const row of this.access.values()) if (row.error) this.access.set(row.key, { ...row, error: null });
    this.load();
  }

  /** K-110: ends every session of every application that kitshn made. */
  private async signOut(caller: Caller) {
    const busy = this.signOutBusy();
    if (busy) return busy;
    // K-110: the Worker checks pages and files itself, so it refuses every login from before this second.
    this.setMeta("signed_out_at", String(Math.floor(Date.now() / 1000) * 1000));
    // K-110: no confirm in the map, so History records the start before any Cloudflare call, and the outcome.
    this.recordRevision(caller.actor, "Sign out everywhere: kitshn refuses older page and file logins");
    return this.finishSignOut(caller, false, async (api) => {
      const apps = await this.listSessionApps(api);
      return "listFailed" in apps ? apps : revokeSessions(api, this.env.CLOUDFLARE_ACCOUNT_ID, apps);
    });
  }

  /** K-110: revokes the sessions that the last sign-out left, or starts over when it could not list them. */
  private async retrySignOut(caller: Caller) {
    const busy = this.signOutBusy();
    if (busy) return busy;
    const left = this.signOutLeft();
    if (!left)
      return Response.json({ error: "Every session of the last sign-out ended already." }, { status: 409 });
    return this.finishSignOut(caller, true, async (api) => {
      const apps = await this.listSessionApps(api);
      if ("listFailed" in apps) return apps;
      return revokeSessions(
        api,
        this.env.CLOUDFLARE_ACCOUNT_ID,
        "listFailed" in left ? apps : retryApps(left.left, apps),
      );
    });
  }

  /** K-110: one sign-out or retry at a time, so a slow run never overwrites the outcome of a newer one. */
  private signOutBusy(): Response | null {
    const since = Number(this.meta("sign_out_running") || 0);
    if (Date.now() - since < SIGN_OUT_RUN_MS)
      return Response.json(
        { error: "A sign-out everywhere runs already. Try again in a minute." },
        { status: 409 },
      );
    return null;
  }

  /** K-110: the applications whose sessions a sign-out ends, or why kitshn could not list them. */
  private async listSessionApps(
    api: Api,
  ): Promise<
    | Array<{ readonly key: string; readonly cfId: string }>
    | { readonly ended: 0; readonly listFailed: string }
  > {
    const logins = new Set(
      ["pages", "files"].flatMap((host) => [
        `${host}.${this.env.KITSHN_ZONE}/login`,
        `${host}.${this.env.KITSHN_ZONE}/login/passkey`,
      ]),
    );
    try {
      const all = await api<Array<{ id: string; name: string; domain: string }>>(
        "GET",
        `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/access/apps?per_page=1000`,
      );
      const loginApps = all
        .filter((app) => logins.has(app.domain) && app.name.startsWith(ACCESS_NAME_PREFIX))
        .map((app) => ({ key: app.domain, cfId: app.id }));
      return sessionApps(this.accessStore(), loginApps);
    } catch (error) {
      return { ended: 0, listFailed: String(error) };
    }
  }

  /** K-110: stores what is left (the warning with Retry) and records the outcome in History. */
  private async finishSignOut(caller: Caller, retry: boolean, run: (api: Api) => Promise<SignOutOutcome>) {
    const api = this.api();
    this.setMeta("sign_out_running", String(Date.now()));
    let outcome: SignOutOutcome;
    try {
      outcome = api ? await run(api) : { ended: 0, listFailed: "kitshn has no Cloudflare API token here" };
    } finally {
      this.setMeta("sign_out_running", "");
    }
    this.setMeta("sign_out_left", signOutWarning(outcome) ? JSON.stringify(outcome) : "");
    this.recordRevision(caller.actor, signOutSummary(outcome, retry));
    return "listFailed" in outcome
      ? Response.json({ error: signOutWarning(outcome) }, { status: 502 })
      : Response.json({
          ended: outcome.ended,
          failed: outcome.left.map((app) => `${app.key}: ${app.reason}`),
        });
  }

  /** K-110: what the last sign-out left to do, or null when every session ended. */
  private signOutLeft(): SignOutOutcome | null {
    return readSignOutLeft(this.meta("sign_out_left"));
  }

  /**
   * A revision without changes, also into the in-memory History list. It never calls `load()`, which would
   * swap the Access map under a sync that awaits Cloudflare.
   */
  private recordRevision(actor: Actor, summary: string) {
    const id = this.insertRevision(actor, summary, [], null);
    this.showRevision({
      id,
      at: Date.now(),
      actor,
      summary,
      undoes: null,
      undoneBy: null,
      undoable: false,
      ...revisionTargets([]),
    });
  }

  /** Puts a new revision at the top of the in-memory History (K-519), marks what it undoes, and tells everyone. */
  private showRevision(revision: RevisionView) {
    this.revisions = [
      revision,
      ...this.revisions.map((old) => (old.id === revision.undoes ? { ...old, undoneBy: revision.id } : old)),
    ].slice(0, RECENT_REVISIONS);
    this.broadcast();
  }

  /** K-106: the Access service tokens of the account, to pick a device member. */
  private async listDevices() {
    const api = this.api();
    if (!api) return Response.json({ error: "kitshn has no Cloudflare API token here." }, { status: 503 });
    try {
      const tokens = await api<Array<{ id: string; name: string; client_id: string }>>(
        "GET",
        `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/access/service_tokens?per_page=1000`,
      );
      return Response.json(
        tokens.map((token) => ({ tokenId: token.id, clientId: token.client_id, name: token.name })),
      );
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 502 });
    }
  }

  /** K-106: one new service token per device. The secret shows once and kitshn does not keep it. */
  private async addDevice(body: unknown) {
    const api = this.api();
    if (!api) return Response.json({ error: "kitshn has no Cloudflare API token here." }, { status: 503 });
    const name = typeof body === "object" && body !== null && "name" in body ? String(body.name).trim() : "";
    if (!name || name.length > 60)
      return Response.json({ error: "Give the device a name of 1 to 60 characters." }, { status: 400 });
    try {
      const token = await api<{ id: string; client_id: string; client_secret: string }>(
        "POST",
        `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/access/service_tokens`,
        { name: `kitshn device ${name}`, duration: "8760h" },
      );
      return Response.json({
        tokenId: token.id,
        clientId: token.client_id,
        clientSecret: token.client_secret,
        name,
      });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 502 });
    }
  }

  /**
   * K-819: part of migration 6. Gives the deploy rows from before the gate their repo id, and allows each
   * repo that finished a deploy then. A row whose card id holds no repo id keeps none; kitshn logs it, and its
   * repo waits for the owner like a new one. A crash here would stop the whole Durable Object over one old row.
   */
  private backfillRepoIds() {
    const rows = this.sql<DeployRow>("SELECT * FROM deploys ORDER BY expires_at");
    const { repoIds, allowed, unknown } = legacyRepos(
      rows.map((row) => ({ ...row, resourceId: row.resource_id })),
    );
    for (const [deployId, repoId] of repoIds)
      this.sql("UPDATE deploys SET repo_id = ? WHERE id = ?", repoId, deployId);
    const now = Date.now();
    for (const [repoId, name] of allowed)
      this.sql(
        "INSERT OR IGNORE INTO repos (repo_id, name, state, first_seen) VALUES (?, ?, 'allowed', ?)",
        repoId,
        name,
        now,
      );
    if (unknown.length > 0)
      console.error(
        `K-819: the card ids of the deploys ${unknown.join(", ")} hold no repo id; their repos wait.`,
      );
  }

  /** K-819: refuses a deploy step of a repo that waits for the owner or that the owner blocked. */
  private repoGate(deployer: Deployer): Response | null {
    const [row] = this.sql<RepoRow>("SELECT * FROM repos WHERE repo_id = ?", deployer.repoId);
    const gate = row ? repoGateOf(row) : undefined;
    const decision = gateDecision(
      gate,
      {
        repoId: deployer.repoId,
        name: deployer.repo,
        branch: deployer.eventName === "push" ? deployer.branch : null,
        workflow: deployer.workflow,
      },
      Date.now(),
      gate !== undefined && this.keyRemoved(gate),
    );
    const record = decision.record;
    // K-819: a deploy step proves that the repo exists on GitHub.
    if (row && row.gone_at !== null && !record) {
      this.sql("UPDATE repos SET gone_at = NULL WHERE repo_id = ?", row.repo_id);
      this.broadcast();
    }
    if (record) {
      this.ctx.storage.transactionSync(() => {
        this.sql(
          `INSERT OR REPLACE INTO repos (repo_id, name, state, first_seen, branch, workflow, allowed_by_client,
             allowed_by_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          record.repoId,
          record.name,
          record.state,
          record.firstSeen,
          record.branch,
          record.workflow,
          record.allowedBy?.clientId ?? null,
          record.allowedBy?.name ?? null,
        );
        if (!row)
          this.insertRevision(
            { _tag: "kitshn", reason: "repo gate" },
            `${record.name} waits to deploy (K-819)`,
            [],
            null,
          );
      });
      this.load();
      this.broadcast();
    }
    return decision.allow ? null : Response.json({ error: decision.error }, { status: 403 });
  }

  /** K-819: the cards on the map that each repo deployed. */
  private repoCards(): Map<string, Array<string>> {
    const cards = new Map<string, Array<string>>();
    for (const { repo_id, resource_id } of this.sql<{ repo_id: string; resource_id: string }>(
      "SELECT repo_id, resource_id FROM deploys WHERE repo_id IS NOT NULL AND kind = 'deploy' GROUP BY repo_id, resource_id",
    ))
      if (this.state.resources.has(resource_id))
        cards.set(repo_id, [...(cards.get(repo_id) ?? []), resource_id]);
    return cards;
  }

  /** K-819: each repo with its cards on the map, for the card panel. */
  private repoViews(): Array<RepoView> {
    const cards = this.repoCards();
    return this.sql<RepoRow>("SELECT * FROM repos ORDER BY first_seen DESC").map((row) => {
      const gate = repoGateOf(row);
      const removed = this.keyRemoved(gate);
      // K-819: the repo of a removed key shows as waiting, so the owner sees it and takes it over.
      return {
        ...gate,
        state: removed ? "waiting" : gate.state,
        keyRemoved: removed,
        goneOnGitHub: row.gone_at !== null,
        resourceIds: cards.get(row.repo_id) ?? [],
      };
    });
  }

  /** K-819: the agent key that allowed this repo has no agent circle anymore (keyRemoved). */
  private keyRemoved(gate: RepoGate) {
    return keyRemoved(
      gate,
      (clientId) => circlesOf(this.state, { email: null, clientId, ip: null }, Date.now()).size > 0,
    );
  }

  /** K-819: the repo id of a card that a deploy made, or null when kitshn does not know it. */
  private repoIdOfCard(resourceId: string): string | null {
    const [row] = this.sql<{ repo_id: string }>(
      "SELECT repo_id FROM deploys WHERE resource_id = ? AND repo_id IS NOT NULL AND kind = 'deploy' LIMIT 1",
      resourceId,
    );
    return row?.repo_id ?? null;
  }

  /** K-819: the agent key that allowed this repo, or null when the owner allowed it. */
  private allowingAgent(repoId: string | null): AllowingAgent | null {
    const [row] = repoId === null ? [] : this.sql<RepoRow>("SELECT * FROM repos WHERE repo_id = ?", repoId);
    return row ? repoGateOf(row).allowedBy : null;
  }

  /** K-819: why kitshn may not deploy this repo now, or null. A repo without a known id or a row waits. */
  private repoRefusal(repoId: string | null): string | null {
    if (repoId === null) return "kitshn does not know the repo of this deploy. Deploy it once from GitHub.";
    const [row] = this.sql<RepoRow>("SELECT * FROM repos WHERE repo_id = ?", repoId);
    if (row?.state === "allowed" && !this.keyRemoved(repoGateOf(row))) return null;
    return row?.state === "blocked"
      ? `The owner blocked deploys of ${row.name} on the kitshn map.`
      : `The repo ${row?.name ?? repoId} waits for the owner on the kitshn map.`;
  }

  /**
   * K-819: the owner allows, blocks or forgets one repo. Allow starts the first refused push through the
   * GitHub App, except during the pause. Block fails the repo's deploys and jobs that have not finished.
   * An agent key with "adds apps" allows a waiting repo too (K-718); `allowedBy` then names it.
   */
  private async setRepoState(
    caller: Caller,
    repoId: string,
    body: unknown,
    allowedBy: AllowingAgent | null = null,
  ) {
    const state = isRecord(body) ? body["state"] : null;
    if (state !== "allowed" && state !== "blocked" && state !== "forget")
      return Response.json({ error: 'Send {"state": "allowed" | "blocked" | "forget"}.' }, { status: 400 });
    const [row] = this.sql<RepoRow>("SELECT * FROM repos WHERE repo_id = ?", repoId);
    if (!row) return Response.json({ error: `kitshn knows no repo ${repoId}.` }, { status: 404 });
    const forgetError =
      state === "forget"
        ? forgetRefusal(
            {
              name: row.name,
              state: row.state,
              goneOnGitHub: row.gone_at !== null,
              keyRemoved: this.keyRemoved(repoGateOf(row)),
            },
            (this.repoCards().get(repoId) ?? []).length,
          )
        : null;
    if (forgetError) return Response.json({ error: forgetError }, { status: 409 });
    const stopped = this.ctx.storage.transactionSync(() => {
      // K-819: Forget stops what the repo has under way as Block does, then drops the row; the repo waits again.
      if (state === "forget") {
        this.sql("DELETE FROM repos WHERE repo_id = ?", repoId);
        this.insertRevision(caller.actor, `Forgot ${row.name} (K-819)`, [], null);
        return this.stopRepoDeploys(repoId, `The owner forgot ${row.name} (K-819).`);
      }
      // K-819: the owner's Allow takes over a repo that an agent key allowed, and clears the key.
      const takeOver = state === "allowed" && allowedBy === null && row.allowed_by_client !== null;
      if (row.state === state && !takeOver) return [];
      if (state === "allowed")
        this.sql(
          "UPDATE repos SET state = 'allowed', allowed_by_client = ?, allowed_by_name = ? WHERE repo_id = ?",
          allowedBy?.clientId ?? null,
          allowedBy?.name ?? null,
          repoId,
        );
      if (state === "blocked")
        this.sql(
          "UPDATE repos SET state = 'blocked', branch = NULL, workflow = NULL, allowed_by_client = NULL, allowed_by_name = NULL WHERE repo_id = ?",
          repoId,
        );
      this.insertRevision(
        caller.actor,
        takeOver && row.state === "allowed"
          ? `Took over deploys of ${row.name} from ${row.allowed_by_name ?? "an agent key"} (K-819)`
          : `${state === "allowed" ? "Allowed" : "Blocked"} deploys of ${row.name} (K-819)`,
        [],
        null,
      );
      if (state === "allowed") return [];
      return this.stopRepoDeploys(repoId, `The owner blocked deploys of ${row.name} (K-819).`);
    });
    const files = stopped
      .filter(({ app }) => app === "compose")
      .flatMap(({ id }) => [deployObject(id, "source.tgz"), deployObject(id, "params.env")]);
    if (files.length > 0 && this.env.BUCKET) void this.env.BUCKET.delete(files);
    this.load();
    this.broadcast();
    if (state !== "allowed" || row.branch === null) return Response.json({ repoId, state });
    if (this.state.paused) return Response.json({ repoId, state, paused: row.branch });
    // The branch is the lock of the start: a second tab finds none and starts nothing.
    const branch = row.branch;
    const [claimed] = this.sql<{ repo_id: string }>(
      "UPDATE repos SET branch = NULL WHERE repo_id = ? AND branch = ? RETURNING repo_id",
      repoId,
      branch,
    );
    if (!claimed) return Response.json({ repoId, state });
    this.broadcast();
    const started = await this.agentBuild(caller, repoId, branch, row.workflow ?? AGENT_WORKFLOW);
    if (started.ok) return Response.json({ repoId, state, dispatched: branch });
    // A failed start gives the branch back, unless the owner blocked or forgot the repo meanwhile.
    this.sql(
      "UPDATE repos SET branch = ? WHERE repo_id = ? AND branch IS NULL AND state = 'allowed'",
      branch,
      repoId,
    );
    this.broadcast();
    return Response.json({
      repoId,
      state,
      dispatchError: ((await started.json()) as { error: string }).error,
    });
  }

  /** K-819: fails the deploys and jobs of a repo that have not finished. A teardown still runs. */
  private stopRepoDeploys(repoId: string, output: string) {
    // A daemon that already has the source can still finish its build.
    this.sql(
      `UPDATE jobs SET state = 'failed', output = ? WHERE state IN ('queued', 'sent')
       AND json_extract(command, '$.kind') != 'compose-down'
       AND json_extract(command, '$.project') IN (SELECT resource_id FROM deploys WHERE repo_id = ?)`,
      output,
      repoId,
    );
    return this.sql<{ id: string; app: string }>(
      `UPDATE deploys SET state = 'failed' WHERE repo_id = ? AND kind = 'deploy' AND state IN ('planned', 'running')
       RETURNING id, app`,
      repoId,
    );
  }

  /**
   * K-819: marks the repos that GitHub reports as deleted, and clears the mark of a repo that exists. The repo
   * list asks for it when it opens. Each repo gets at most one answer a day, and only an answer writes a row.
   */
  private async checkReposOnGitHub(): Promise<Response> {
    const appId = this.env.GITHUB_APP_ID;
    const key = this.env.GITHUB_APP_KEY;
    if (!appId || !key || this.checkingRepos) return Response.json({ checked: 0 });
    const now = Date.now();
    const due = this.sql<RepoRow>(
      "SELECT * FROM repos WHERE checked_at IS NULL OR checked_at <= ? ORDER BY coalesce(checked_at, 0)",
      now - DAY_MS,
    );
    if (due.length === 0) return Response.json({ checked: 0 });
    this.checkingRepos = true;
    let found: Map<string, RepoOnGitHub>;
    try {
      found = await reposOnGitHub(
        { id: appId, key },
        due.map((row) => ({ repoId: row.repo_id, name: row.name })),
        GITHUB_CALLS_PER_CHECK,
      );
    } finally {
      this.checkingRepos = false;
    }
    let changed = false;
    this.ctx.storage.transactionSync(() => {
      for (const row of due) {
        const answer = found.get(row.repo_id);
        // A skipped repo (the call budget ran out) waits for the next check; every answer counts as a check,
        // so an unknown repo never sorts first again and starves the others.
        if (answer === undefined) continue;
        const goneAt = answer === "gone" ? (row.gone_at ?? now) : answer === "unknown" ? row.gone_at : null;
        // A deploy step or Forget can change the row while GitHub answers; it then keeps what they wrote.
        const [updated] = this.sql<{ repo_id: string }>(
          "UPDATE repos SET checked_at = ?, gone_at = ? WHERE repo_id = ? AND gone_at IS ? RETURNING repo_id",
          now,
          goneAt,
          row.repo_id,
          row.gone_at,
        );
        if (!updated || goneAt === row.gone_at) continue;
        changed = true;
        this.insertRevision(
          { _tag: "kitshn", reason: "GitHub" },
          goneAt === null ? `GitHub reports ${row.name} again (K-819)` : `GitHub deleted ${row.name} (K-819)`,
          [],
          null,
        );
      }
    });
    if (changed) {
      this.load();
      this.broadcast();
    }
    return Response.json({ checked: [...found.values()].filter((answer) => answer !== "unknown").length });
  }

  /** K-803 to K-807, K-901 to K-904: the steps of a static site deploy from GitHub Actions. */
  private async deployStep(path: string, deployer: Deployer, body: unknown): Promise<Response> {
    const api = this.api();
    if (!api) return Response.json({ error: "kitshn has no Cloudflare API token here." }, { status: 503 });
    const input = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const fail = (status: number, error: string) => Response.json({ error }, { status });
    try {
      if (path === "/deploy/plan") return await this.planDeploy(api, deployer, input);
      if (path === "/deploy/status") return this.composeStatus(deployer, String(input["deployId"] ?? ""));
      const [row] = this.sql<DeployRow>(
        "SELECT * FROM deploys WHERE id = ?",
        String(input["deployId"] ?? ""),
      );
      if (!row || row.repo_id !== deployer.repoId)
        return fail(404, "kitshn knows no such deploy of this repo.");
      // K-820: the CLI records why a deploy failed, so its card shows it; a deploy that already ended keeps its state.
      if (path === "/deploy/fail") {
        const reason =
          typeof input["reason"] === "string" ? input["reason"].slice(0, 500) : "The deploy failed.";
        // A running Compose deploy keeps running: its machine job decides the result and still lands, and the deploy
        // still holds off a second deploy and a removal (deployRuns). The give-up of the CLI stays as its reason.
        this.sql(
          `UPDATE deploys SET state = CASE WHEN state = 'running' THEN 'running' ELSE 'failed' END, reason = ?
           WHERE id = ? AND state IN ('planned', 'running', 'failed')`,
          reason,
          row.id,
        );
        this.broadcast();
        return Response.json({ ok: true });
      }
      if (row.expires_at < Date.now() || row.state !== "planned")
        return fail(410, "This deploy expired or ended. Run it again.");
      // A blocked repo still tears down what it made (K-819).
      const gate = row.kind === "teardown" ? null : this.repoGate(deployer);
      if (gate) return gate;
      if (path === "/deploy/assets" && row.kind === "deploy")
        return await this.deployAssets(api, row, input["manifest"]);
      if (row.app === "worker" && row.kind === "deploy") {
        if (path === "/deploy/storage") return await this.workerStorage(api, row);
        if (path === "/deploy/finish") return await this.finishWorker(api, row, deployer, input);
      }
      if (path === "/deploy/finish" && row.kind === "deploy")
        return await this.finishDeploy(
          api,
          row,
          deployer,
          input["jwt"],
          input["icon"],
          input["headers"],
          input["redirects"],
        );
      if (row.app === "compose") {
        if (path === "/deploy/start" && row.kind === "deploy")
          return await this.startCompose(api, row, deployer);
        if (path === "/deploy/teardown" && row.kind === "teardown")
          return this.teardownCompose(row, deployer);
        return fail(400, `${path} does not fit a Compose deploy.`);
      }
      if (path === "/deploy/teardown" && row.kind === "teardown")
        return await this.teardown(api, row, deployer);
      return fail(400, `${path} does not fit this deploy.`);
    } catch (error) {
      if (error instanceof RuleError) return fail(400, error.message);
      return fail(502, `kitshn could not finish the step: ${String(error)}`);
    }
  }

  private async planDeploy(api: Api, deployer: Deployer, input: Record<string, unknown>) {
    let recipe: Recipe;
    try {
      recipe = decodeRecipe(input["recipe"]);
    } catch (error) {
      return Response.json(
        { error: `The recipe does not match the schema (K-803): ${String(error)}` },
        { status: 400 },
      );
    }
    const event = eventOf(deployer, input["event"]);
    if (typeof event === "string") return Response.json({ error: event }, { status: 400 });
    // K-804: a CLI from before several apps sends no key; its one app is the app `app`.
    const key = input["key"] ?? DEFAULT_APP;
    if (!Schema.is(AppKey)(key))
      return Response.json(
        { error: "The app key is a lowercase letter, then up to 19 letters or digits (K-804)." },
        { status: 400 },
      );
    const skip = input["skip"];
    if (skip !== undefined && (typeof skip !== "string" || skip === "" || skip.length > 500))
      return Response.json(
        { error: "A skip reason is text of at most 500 characters (K-820)." },
        { status: 400 },
      );
    // A broken KITSHN_ZONES leaves only the kitshn zone, so a deploy there still works (K-1111).
    let zones: Array<Zone>;
    try {
      zones = zonesOf(this.env);
    } catch (error) {
      console.error(`kitshn cannot read KITSHN_ZONES (K-1111): ${String(error)}`);
      zones = [{ name: this.env.KITSHN_ZONE, id: this.env.CLOUDFLARE_ZONE_ID }];
    }
    const result = plan(
      recipe,
      deployer.repo,
      event,
      this.env.KITSHN_ZONE,
      zones.slice(1).map((zone) => zone.name),
      key,
    );
    if (result.kind === "error") return Response.json({ error: result.reason }, { status: 400 });
    if (result.kind === "skip") return Response.json({ deployId: null, plan: result });
    // K-1504: no new deploy while paused; a teardown still runs, because it only lowers access.
    if (result.kind === "deploy" && this.state.paused)
      return Response.json(
        { error: "kitshn is paused (Emergency pause). Deploys wait until the owner resumes." },
        { status: 423 },
      );
    // A blocked repo still tears down what it made (K-819).
    const gate = result.kind === "teardown" ? null : this.repoGate(deployer);
    if (gate) return gate;
    const { resourceId, script } = environmentNames(deployer.repoId, deployer.repo, result.environment, key);
    // K-804: a card belongs to one app of its repo; two apps whose long ids hash alike never share it.
    const [owner] = this.sql<{ app_key: string; repo_id: string | null }>(
      "SELECT app_key, repo_id FROM deploys WHERE resource_id = ? ORDER BY rowid DESC LIMIT 1",
      resourceId,
    );
    if (owner && (owner.app_key !== key || (owner.repo_id !== null && owner.repo_id !== deployer.repoId)))
      return Response.json(
        {
          error: `The card ${resourceId} belongs to another app (${owner.app_key}); give this app another key.`,
        },
        { status: 409 },
      );
    const existing = this.state.resources.get(resourceId);
    if (this.deletingStorage.has(resourceId))
      return Response.json(
        { error: `kitshn deletes the storage of ${resourceId} now. Deploy again after it finishes (K-909).` },
        { status: 409 },
      );
    // K-804: a card keeps its kind, because its removal and its teardown follow the kind. A deploy of another kind
    // would leave the old app running behind a card that cannot take it down.
    const kind = "compose" in recipe ? "site.compose" : "worker" in recipe ? "site.worker" : "site.static";
    if (existing && existing.kind !== kind)
      return Response.json(
        {
          error: `${existing.name} is a ${existing.kind} card, and the recipe makes a ${kind}. Remove the app on the map first (K-909).`,
        },
        { status: 409 },
      );
    // K-811: a number that only the request names may close a preview, and only the one that this head
    // branch deployed itself.
    if ("claimed" in event && event.claimed) {
      const [own] = this.sql<{ id: string }>(
        "SELECT id FROM deploys WHERE resource_id = ? AND kind = 'deploy' AND branch = ? LIMIT 1",
        resourceId,
        event.branch,
      );
      // GitHub gives no token to pull requests from forks, so the head branch names a branch of this repo.
      if (result.kind !== "teardown" || !own || event.branch === "") {
        return Response.json({
          deployId: null,
          plan: {
            kind: "skip",
            reason: `The token names no pull request, and ${event.branch || "this run"} deployed no preview pr-${event.pr}; remove it on the map.`,
          },
        });
      }
    }
    // K-820: an app whose needed app did not deploy records why, so its card shows it, and changes nothing.
    if (typeof skip === "string" && result.kind === "deploy") {
      this.sql(
        `INSERT INTO deploys (id, repo, repo_id, environment, resource_id, address, script, starts_in, kind, sha, state, expires_at, branch, app, addresses, app_key, reason, run_id, run_attempt, needs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'deploy', ?, 'skipped', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        deployer.repo,
        deployer.repoId,
        result.environment,
        resourceId,
        result.address,
        script,
        result.startsIn,
        deployer.sha,
        Date.now() + DEPLOY_MS,
        event.branch,
        "compose" in recipe ? "compose" : "worker" in recipe ? "worker" : "static",
        JSON.stringify(result.addresses),
        key,
        skip,
        deployer.runId,
        deployer.runAttempt,
        JSON.stringify(recipe.needs?.apps ?? []),
      );
      this.broadcast();
      return Response.json({ deployId: null, plan: { kind: "skip", reason: skip } });
    }
    const compose = "compose" in recipe ? recipe.compose : null;
    // K-819: the Compose apps of a repo that an agent key allowed run only where that key may run jobs.
    const allowedBy = this.allowingAgent(deployer.repoId);
    const agentLimit = allowedBy
      ? ` The agent key ${allowedBy.name} allowed this repo, so it deploys only to a machine whose card, and every card on it, that key manages (K-819).`
      : "";
    // K-610, K-611: a new Compose app goes to the first online machine with all labels; a running one stays.
    let machineId: string | null = null;
    if (compose) {
      if (existing?.machine) {
        // K-611: a running app stays on its machine, but only while the owner still offers it (K-610).
        if (!this.state.machines.get(existing.machine)?.labels.includes("deploy")) {
          return Response.json(
            {
              error: `${existing.name} runs on a machine without the label "deploy". Label it again, or remove the card to deploy elsewhere.`,
            },
            { status: 409 },
          );
        }
        // A teardown skips the agent machine check (K-819); the label and address checks still apply.
        if (
          result.kind === "deploy" &&
          !mayDeployOn(this.state, allowedBy?.clientId ?? null, existing.machine, Date.now())
        )
          return Response.json(
            { error: `${existing.name} runs on a machine that it may no longer use.${agentLimit}` },
            { status: 409 },
          );
        machineId = existing.machine;
        const running = this.state.machines.get(existing.machine);
        if (
          result.kind === "deploy" &&
          running &&
          !this.machineView(running).status?.capabilities?.includes("compose-guard")
        )
          return Response.json(
            {
              error: `Update the daemon on ${running.name} first: it does not check Compose settings yet (K-818).`,
            },
            { status: 409 },
          );
      } else if (result.kind === "deploy") {
        const labels = compose.runsOn ?? [];
        // K-1708: a machine without a key is online for status only and gets no job.
        const ready = this.jobMachines();
        const pick = [...this.state.machines.values()]
          // Only a machine that the owner labels "deploy" runs the apps of repos (K-610).
          .filter((machine) => ["deploy", ...labels].every((label) => machine.labels.includes(label)))
          // K-818: only a daemon that checks Compose settings runs the apps of repos.
          .filter((machine) => this.machineView(machine).status?.capabilities?.includes("compose-guard"))
          .filter((machine) => mayDeployOn(this.state, allowedBy?.clientId ?? null, machine.id, Date.now()))
          .sort((a, b) => a.order - b.order)
          .find((machine) => ready.has(machine.id));
        if (!pick) {
          return Response.json(
            {
              error: `No online machine with a Compose-ready daemon has the labels ${["deploy", ...labels].join(", ")}. Label a machine "deploy", update its daemon, start it, or give it a key (K-1708).${agentLimit}`,
            },
            { status: 409 },
          );
        }
        machineId = pick.id;
      }
    }
    if (existing && existing.addresses[0] !== result.address) {
      return Response.json(
        {
          error: `${result.environment} lives at ${existing.addresses[0]}. To move it, remove its card on the map first.`,
        },
        { status: 409 },
      );
    }
    // K-817: the plan refuses kitshn's own names; the admin host can have another name.
    if (result.addresses.slice(1).includes(this.env.KITSHN_HOST))
      return Response.json(
        { error: `${this.env.KITSHN_HOST} is the kitshn admin host (K-817).` },
        { status: 409 },
      );
    for (const address of result.addresses) {
      const other = [...this.state.resources.values()].find(
        (resource) => resource.id !== resourceId && resource.addresses.includes(address),
      );
      if (other)
        return Response.json({ error: `${address} belongs to the card ${other.name}.` }, { status: 409 });
    }
    if (result.kind === "deploy") {
      // Never take over a hostname that another Worker serves, or that a foreign Access app covers (K-408).
      const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
      const apps = await api<Array<{ name: string; domain?: string }>>(
        "GET",
        `${account}/access/apps?per_page=1000`,
      );
      for (const address of result.addresses) {
        const domains = await api<Array<{ service: string }>>(
          "GET",
          `${account}/workers/domains?hostname=${encodeURIComponent(address)}`,
        );
        const foreign = domains.find((domain) => domain.service !== script);
        if (foreign) {
          return Response.json(
            { error: `${address} already serves the Worker ${foreign.service}.` },
            { status: 409 },
          );
        }
        const foreignApp = apps.find((app) => app.domain === address && !app.name.startsWith("kitshn "));
        if (foreignApp) {
          return Response.json(
            {
              error: `The Access application "${foreignApp.name}" covers ${address}; kitshn does not change it.`,
            },
            { status: 409 },
          );
        }
        // Only an address that nothing uses yet: kitshn never takes over a record that it did not make (K-1404).
        // A record that kitshn made for this same card (an address that comes back before its record went) is fine.
        if (existing?.addresses.includes(address)) continue;
        const [kitshnRow] = this.sql<{ card_id: string | null }>(
          "SELECT card_id FROM dns_objects WHERE address = ? AND record_id != ''",
          address,
        );
        if (kitshnRow?.card_id === resourceId) continue;
        const zone = zoneFor(address, zones);
        if (!zone)
          return Response.json(
            { error: `kitshn does not publish on the zone of ${address} (K-1111).` },
            { status: 409 },
          );
        const records = await api<Array<{ type: string }>>(
          "GET",
          `/zones/${zone.id}/dns_records?name=${encodeURIComponent(address)}`,
        );
        const refusal = dnsRecordRefusal(address, addressRecords(records), kitshnRow, resourceId);
        if (refusal) return Response.json({ error: refusal }, { status: 409 });
      }
    }
    if (result.kind === "deploy" && !existing) {
      if (result.ephemeral && !compose) {
        const scripts = await api<Array<unknown>>(
          "GET",
          `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts`,
        );
        if (scripts.length >= SCRIPT_LIMIT) {
          return Response.json(
            {
              error: `The account has ${scripts.length} Worker scripts; kitshn opens no preview at ${SCRIPT_LIMIT} (K-903).`,
            },
            { status: 409 },
          );
        }
      }
    }
    // K-807: a push environment stays with the branch that made it, so another branch cannot deploy over prod.
    if (event.name === "push") {
      const [first] = this.sql<{ branch: string }>(
        "SELECT branch FROM deploys WHERE resource_id = ? AND kind = 'deploy' AND state = 'done' AND branch != '' ORDER BY expires_at LIMIT 1",
        resourceId,
      );
      if (first && first.branch !== event.branch) {
        return Response.json(
          {
            error: `${result.environment} deploys only from the branch ${first.branch}, not ${event.branch}.`,
          },
          { status: 403 },
        );
      }
    }
    const deployId = crypto.randomUUID();
    this.sql(
      `INSERT INTO deploys (id, repo, repo_id, environment, resource_id, address, script, starts_in, kind, sha, state, expires_at, branch, app, machine_id, compose_file, addresses, worker, app_key, run_id, run_attempt, needs, workflow)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      deployId,
      deployer.repo,
      deployer.repoId,
      result.environment,
      resourceId,
      result.address,
      script,
      result.startsIn,
      result.kind,
      deployer.sha,
      Date.now() + DEPLOY_MS,
      // A push binds its environment to the branch (K-807); a preview records its head branch for its close.
      event.branch,
      compose ? "compose" : "worker" in recipe ? "worker" : "static",
      machineId,
      compose?.file ?? null,
      JSON.stringify(result.addresses),
      "worker" in recipe ? JSON.stringify(recipe.worker) : null,
      key,
      deployer.runId,
      deployer.runAttempt,
      JSON.stringify(recipe.needs?.apps ?? []),
      deployer.workflow,
    );
    return Response.json({ deployId, plan: result });
  }

  private async deployAssets(api: Api, row: DeployRow, value: unknown) {
    const manifest = parseManifest(value);
    if (typeof manifest === "string") return Response.json({ error: manifest }, { status: 400 });
    const session = await api<{ jwt: string; buckets?: Array<Array<string>> }>(
      "POST",
      `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${row.script}/assets-upload-session`,
      { manifest },
    );
    // The upload token can only upload these files; Actions sends them straight to Cloudflare.
    return Response.json({
      jwt: session.jwt,
      buckets: session.buckets ?? [],
      uploadUrl: `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/assets/upload?base64=true`,
    });
  }

  /**
   * The card of a deployed environment: new cards start in the `startsIn` circle (K-807) or wait in the tray
   * (K-509); an existing card keeps its place. Returns a line for the deploy log.
   */
  private ensureCard(
    row: DeployRow,
    deployer: Deployer,
    kind: "site.static" | "site.worker" | "site.compose",
    machine: string | null,
  ) {
    const actor: Actor = { _tag: "kitshn", reason: `deploy of ${row.repo} ${deployer.sha.slice(0, 7)}` };
    const addresses = rowAddresses(row);
    const existing = this.state.resources.get(row.resource_id);
    if (existing) {
      // K-817, K-410: a Compose card takes the new list at once; the tunnel sync drops an old address in order. A
      // static card keeps its old addresses until finishDeploy has taken their custom domains off.
      const next = nextCardAddresses(kind, addresses, existing.addresses);
      if (JSON.stringify(next) !== JSON.stringify(existing.addresses)) {
        this.putResource({ ...existing, addresses: next });
        this.load();
      }
      return "The card keeps its place; the map decides who opens it (K-807).";
    }
    const slug = repoSlug(row.repo);
    // K-909: the row of a removed app with this id would take the new card with it (dropLiveSite).
    if (kind === "site.compose") dropLiveSite(this.query, row.resource_id);
    this.putResource({
      id: row.resource_id,
      kind,
      // K-804: an app other than `app` has its key in the name, as in its default address.
      name: `${row.app_key === DEFAULT_APP ? slug : `${slug}-${row.app_key}`}${row.environment === "prod" ? "" : ` ${row.environment}`}`,
      addresses,
      status: "deploying",
      group: slug,
      machine,
    });
    this.load();
    // K-819: the card of a repo that an agent key allowed starts in that key's circle, never in `startsIn`.
    const allowedBy = this.allowingAgent(row.repo_id);
    const circle = allowedBy
      ? agentHomeCircle(this.state, allowedBy.clientId, Date.now())
      : row.starts_in
        ? [...this.state.circles.values()].find((item) =>
            [item.id, item.name.toLowerCase()].includes(row.starts_in!.toLowerCase()),
          )
        : undefined;
    const place = circle ? placeInside(this.state, { x: circle.x, y: circle.y }, new Set([circle.id])) : null;
    // K-1504: a deploy that was running when the pause started finishes with its card in the tray.
    if (circle && place && !this.state.paused) {
      this.commit(
        actor,
        resolveEdits(this.state, [{ _tag: "place", id: row.resource_id, after: place }]),
        null,
      );
      return allowedBy
        ? `The card starts in ${circle.name}, a circle of the agent key ${allowedBy.name} that allowed the repo (K-819).`
        : `The card starts in ${circle.name} (K-807).`;
    }
    this.insertRevision(actor, `Deployed ${row.repo} ${row.environment}`, [], null);
    this.load();
    return "The card waits in the tray, so the site is private until you share it on the map (K-509).";
  }

  /**
   * K-819: a step checks this after each wait on the network, because Block ends the repo's planned deploys
   * meanwhile. Null while the deploy is still planned.
   */
  private endedRefusal(deployId: string): Response | null {
    const [row] = this.sql<{ state: string }>("SELECT state FROM deploys WHERE id = ?", deployId);
    if (row?.state === "planned") return null;
    return Response.json(
      { error: "This deploy ended during the step, for example because the owner blocked the repo (K-819)." },
      { status: 409 },
    );
  }

  /** K-812: the source archive and the params of a Compose deploy go to R2 until the job ends. */
  private async deployFile(path: string, deployer: Deployer, request: Request) {
    const fail = (status: number, error: string) => Response.json({ error }, { status });
    const gate = this.repoGate(deployer);
    if (gate) return gate;
    const [row] = this.sql<DeployRow>(
      "SELECT * FROM deploys WHERE id = ?",
      request.headers.get("x-kitshn-deploy") ?? "",
    );
    if (!row || row.repo_id !== deployer.repoId || row.app !== "compose" || row.kind !== "deploy")
      return fail(404, "kitshn knows no such Compose deploy of this repo.");
    if (row.state !== "planned" || row.expires_at < Date.now())
      return fail(410, "This deploy expired or started.");
    const bucket = this.env.BUCKET;
    if (!bucket || !request.body) return fail(503, "R2 is off, or the request has no body.");
    const limit = path === "/deploy/archive" ? 95 * 1024 * 1024 : 256 * 1024;
    const size = Number(request.headers.get("content-length"));
    if (!Number.isInteger(size) || size < 0) return fail(411, "Send a Content-Length.");
    if (size > limit) return fail(413, `${path} takes at most ${limit} bytes.`);
    const { readable, writable } = new FixedLengthStream(size);
    const piped = request.body.pipeTo(writable);
    const object = deployObject(row.id, path === "/deploy/archive" ? "source.tgz" : "params.env");
    try {
      await bucket.put(object, readable);
      await piped;
    } catch (error) {
      await piped.catch(() => undefined);
      return fail(502, `The upload did not reach R2: ${String(error)}`);
    }
    // Block deletes the files of the deploys it ends; a file that lands after that goes too (K-819).
    const ended = this.endedRefusal(row.id);
    if (ended) await bucket.delete(object);
    return ended ?? Response.json({ ok: true });
  }

  /** K-812: a daemon reads the files of a deploy only while it runs that deploy's job. */
  private async deploySource(path: string, caller: Caller) {
    const [deployId = "", file = ""] = path.slice("/connect/deploys/".length).split("/");
    const machine = [...this.state.machines.values()].find(
      (item) => item.clientId === caller.visitor.clientId,
    );
    const [row] = this.sql<DeployRow>("SELECT * FROM deploys WHERE id = ?", deployId);
    const [job] = row?.job_id
      ? this.sql<{ state: string; machine_id: string }>(
          "SELECT state, machine_id FROM jobs WHERE id = ?",
          row.job_id,
        )
      : [];
    if (
      !machine ||
      !row ||
      job?.machine_id !== machine.id ||
      job.state !== "sent" ||
      !["source.tgz", "params.env"].includes(file)
    )
      return new Response("This machine runs no such deploy now.", { status: 404 });
    const refusal = this.repoRefusal(row.repo_id);
    if (refusal) return new Response(refusal, { status: 403 });
    const object = await this.env.BUCKET?.get(deployObject(deployId, file));
    if (!object) return new Response("The file of this deploy is gone.", { status: 404 });
    return new Response(object.body);
  }

  /** K-812: makes the card and its Access application, then sends the Compose job to the chosen machine. */
  private async startCompose(api: Api, row: DeployRow, deployer: Deployer) {
    const machine = row.machine_id ? this.state.machines.get(row.machine_id) : undefined;
    if (!machine) return Response.json({ error: "The machine of this deploy is gone." }, { status: 409 });
    // K-819: the plan checked the machine; the key can lose it before the start. Check before the card exists.
    const allowedBy = this.allowingAgent(row.repo_id);
    if (!mayDeployOn(this.state, allowedBy?.clientId ?? null, machine.id, Date.now()))
      return Response.json(
        {
          error: `The agent key ${allowedBy?.name} that allowed this repo no longer manages ${machine.name} (K-819).`,
        },
        { status: 409 },
      );
    const card = this.ensureCard(row, deployer, "site.compose", machine.id);
    // Fail closed: the Access application exists before the tunnel sends the address to the app (K-410, K-817).
    await this.syncAccessLocked(api, 20);
    const notReady = this.accessNotReady(row);
    if (notReady) return notReady;
    const ended = this.endedRefusal(row.id);
    if (ended) return ended;
    const command: Command = {
      kind: "compose",
      deployId: row.id,
      allowed: allowedFor(machine, row.repo),
      project: row.resource_id,
      name: row.address.slice(0, -this.env.KITSHN_ZONE.length - 1),
      environment: row.environment,
      repo: row.repo,
      file: row.compose_file,
    };
    this.ctx.storage.transactionSync(() => {
      const jobId = this.queueKitshnJob(
        machine.id,
        command,
        { _tag: "kitshn", reason: `deploy of ${row.repo}` },
        Date.now() + DEPLOY_MS,
      );
      this.sql("UPDATE deploys SET state = 'running', job_id = ? WHERE id = ?", jobId, row.id);
    });
    this.deliverJobs();
    this.broadcast();
    return Response.json({ machine: machine.name, card });
  }

  /** K-813: the state and output of a Compose deploy, for the Actions step that waits on it. */
  private composeStatus(deployer: Deployer, deployId: string) {
    const [row] = this.sql<DeployRow>("SELECT * FROM deploys WHERE id = ?", deployId);
    if (!row || row.repo_id !== deployer.repoId || row.job_id === null)
      return Response.json({ error: "kitshn knows no such running deploy of this repo." }, { status: 404 });
    const [job] = this.sql<{ state: string; output: string; exit_code: number | null; expires_at: number }>(
      "SELECT state, output, exit_code, expires_at FROM jobs WHERE id = ?",
      row.job_id,
    );
    // A dropped connection fails the job only for now: kitshn still takes its real result (OFFLINE_OUTPUT),
    // until the job would have expired; a daemon that restarted never sends it.
    const waiting = job?.state === "failed" && job.output === OFFLINE_OUTPUT && job.expires_at > Date.now();
    const state =
      job?.state === "done"
        ? "done"
        : (job?.state === "failed" && !waiting) || job?.state === "expired"
          ? job.state
          : "running";
    if (state !== "running" && row.state === "running")
      this.sql("UPDATE deploys SET state = ? WHERE id = ?", state === "done" ? "done" : "failed", row.id);
    return Response.json({
      state,
      output: waiting ? "" : (job?.output ?? ""),
      exitCode: job?.exit_code ?? null,
    });
  }

  /** K-904: a closed pull request stops its Compose preview; its card goes once the machine stops exposing it. */
  private teardownCompose(row: DeployRow, deployer: Deployer) {
    const resource = this.state.resources.get(row.resource_id);
    const machineId = resource?.machine ?? row.machine_id;
    // The name comes from the card, not from the recipe of this request, so a close stops only its own app.
    const address = resource?.addresses[0] ?? row.address;
    const name = address.slice(0, -this.env.KITSHN_ZONE.length - 1);
    this.ctx.storage.transactionSync(() => {
      if (machineId)
        this.queueKitshnJob(
          machineId,
          { kind: "compose-down", project: row.resource_id, name, removeData: true },
          { _tag: "kitshn", reason: `pull request closed in ${row.repo}, ${deployer.sha.slice(0, 7)}` },
          Date.now() + JOB_EXPIRY_MS,
        );
      this.sql("UPDATE deploys SET state = 'done' WHERE id = ?", row.id);
      // A preview that never came up has no live site to take its card away.
      if (resource && ![...this.liveSites.values()].some((site) => site.id === row.resource_id))
        this.insertRevision(
          { _tag: "kitshn", reason: `pull request closed in ${row.repo}, ${deployer.sha.slice(0, 7)}` },
          `Removed ${resource.name}, its preview closed (K-904)`,
          [this.forgetCard(row.resource_id)],
          null,
        );
    });
    this.load();
    this.deliverJobs();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ removed: row.address });
  }

  /** K-410, K-817: a 503 while the Access application of an address of the deploy is not made yet. */
  private accessNotReady(row: DeployRow) {
    for (const address of rowAddresses(row)) {
      const app = this.access.get(`app:${row.resource_id}:${address}`);
      if (!app?.cfId || app.error)
        return Response.json(
          {
            error: `The Access application of ${address} is not ready: ${app?.error ?? "pending"}. Run the deploy again.`,
          },
          { status: 503 },
        );
    }
    return null;
  }

  private async finishDeploy(
    api: Api,
    row: DeployRow,
    deployer: Deployer,
    jwt: unknown,
    iconValue: unknown,
    headersValue: unknown,
    redirectsValue: unknown,
  ) {
    if (typeof jwt !== "string" || !jwt)
      return Response.json({ error: "The deploy needs the upload completion token." }, { status: 400 });
    const headers = parseConfigFile("_headers", headersValue);
    if (typeof headers === "object" && headers !== null)
      return Response.json({ error: headers.error }, { status: 400 });
    const redirects = parseConfigFile("_redirects", redirectsValue);
    if (typeof redirects === "object" && redirects !== null)
      return Response.json({ error: redirects.error }, { status: 400 });
    const icon = parseSiteIcon(iconValue);
    if (typeof icon === "string") return Response.json({ error: icon }, { status: 400 });
    const metadata = {
      main_module: "worker.js",
      compatibility_date: "2026-10-20",
      assets: {
        jwt,
        config: {
          not_found_handling: "404-page",
          html_handling: "auto-trailing-slash",
          ...(headers ? { _headers: headers } : {}),
          ...(redirects ? { _redirects: redirects } : {}),
        },
      },
      bindings: [{ type: "assets", name: "ASSETS" }],
    };
    return this.publish(api, row, deployer, "site.static", icon, async () => ({
      metadata,
      module: STATIC_WORKER,
    }));
  }

  /**
   * K-806: the deploy of a Worker app. The bindings come from the recipe that the plan stored, the KV ids from the
   * storage step, the classes and their migration from what the script has now (classMigration).
   */
  private async finishWorker(api: Api, row: DeployRow, deployer: Deployer, input: Record<string, unknown>) {
    const fail = (error: string) => Response.json({ error }, { status: 400 });
    const app = workerOf(row);
    const module = parseWorkerModule(input["module"]);
    if (typeof module !== "string") return fail(module.error);
    const secrets = parseWorkerSecrets(input["secrets"]);
    if ("error" in secrets) return fail(secrets.error);
    const headers = parseConfigFile("_headers", input["headers"]);
    if (typeof headers === "object" && headers !== null) return fail(headers.error);
    const redirects = parseConfigFile("_redirects", input["redirects"]);
    if (typeof redirects === "object" && redirects !== null) return fail(redirects.error);
    const icon = parseSiteIcon(input["icon"]);
    if (typeof icon === "string") return fail(icon);
    const jwt = input["jwt"];
    if (app.assets !== undefined && (typeof jwt !== "string" || !jwt))
      return fail("The deploy needs the upload completion token of the assets.");
    const kv = new Map(
      this.sql<{ name: string; cf_id: string }>(
        "SELECT name, cf_id FROM worker_storage WHERE card_id = ? AND kind = 'kv'",
        row.resource_id,
      ).map((item) => [item.name, item.cf_id]),
    );
    const ephemeral = isPreview(row.environment);
    const crons = ephemeral ? [] : (app.crons ?? []);
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    if (this.deletingStorage.has(row.resource_id))
      return fail(
        `kitshn deletes the storage of ${row.resource_id} now. Deploy again after it finishes (K-909).`,
      );
    const response = await this.publish(
      api,
      row,
      deployer,
      "site.worker",
      icon,
      async () => {
        const metadata = workerMetadata(app, {
          kv,
          secrets: secrets.secrets,
          assets:
            app.assets === undefined
              ? null
              : {
                  jwt: jwt as string,
                  headers: headers as string | null,
                  redirects: redirects as string | null,
                },
        });
        if ("error" in metadata) throw new RuleError(metadata.error);
        return { metadata: metadata.metadata, module };
      },
      // K-806: the schedules belong to the script, so they change after the upload, but before the addresses and
      // before the card says that the deploy is live. A preview runs no crons, so it never runs them twice.
      async () => {
        if (!ephemeral)
          await api(
            "PUT",
            `${account}/workers/scripts/${row.script}/schedules`,
            crons.map((cron) => ({ cron })),
          );
      },
    );
    if (!response.ok) return response;
    // A deploy brings a removed Worker app back, so its kept script is no longer orphaned (K-909).
    this.sql("DELETE FROM worker_storage WHERE card_id = ? AND kind = 'script'", row.resource_id);
    const notes: Array<string> = [];
    if (crons.length > 0) notes.push(`crons: ${crons.join(", ")}`);
    if (ephemeral && (app.crons ?? []).length > 0) notes.push("a preview runs no crons (K-806).");
    const body = (await response.json()) as Record<string, unknown>;
    return Response.json({ ...body, notes });
  }

  /**
   * K-805, K-806: uploads the Worker of a deploy and publishes it at its addresses. `build` gives the upload metadata
   * and the one module; `afterUpload` runs before the addresses go live.
   * K-406: at most 43 of the 50 subrequests of the Free plan, with 5 addresses (K-817): the Access sync 20, the script
   * list 1, the upload 1, its version 1 (K-820), workers.dev 1, the schedules 1, a lookup and an attach per address 10,
   * the stale domains 2 lists and up to 5 deletes, and the route check 1. Keep it at most 45 when a step joins.
   */
  private async publish(
    api: Api,
    row: DeployRow,
    deployer: Deployer,
    kind: "site.static" | "site.worker",
    icon: { readonly bytes: Uint8Array; readonly type: string } | null | undefined,
    build: () => Promise<{ readonly metadata: Record<string, unknown>; readonly module: string }>,
    afterUpload: () => Promise<void> = async () => undefined,
  ) {
    const card = this.ensureCard(row, deployer, kind, null);
    // Fail closed: the Access application of each address exists before the address does (K-817).
    await this.syncAccessLocked(api, 20);
    const notReady = this.accessNotReady(row);
    if (notReady) return notReady;
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    const scripts = await api<Array<{ id: string }>>("GET", `${account}/workers/scripts`);
    const isNew = !scripts.some((item) => item.id === row.script);
    const { metadata, module } = await build();
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("worker.js", new Blob([module], { type: "application/javascript+module" }), "worker.js");
    // An existing site goes live with this upload, so Block must win right before it.
    const endedBeforeUpload = this.endedRefusal(row.id);
    if (endedBeforeUpload) return endedBeforeUpload;
    const upload = await fetch(
      `https://api.cloudflare.com/client/v4${account}/workers/scripts/${row.script}`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}` },
        body: form,
      },
    );
    const uploaded = (await upload.json()) as { success: boolean; errors?: unknown };
    if (!uploaded.success) throw new Error(`the Worker upload failed: ${JSON.stringify(uploaded.errors)}`);
    // K-820: the version that this upload made, for a later rollback to it (K-821). The script is live already, so a
    // failed read only takes the rollback to this deploy away; it logs a warning and stores null.
    const versionId = await api<{ deployments: Array<{ versions: Array<{ version_id: string }> }> }>(
      "GET",
      `${account}/workers/scripts/${row.script}/deployments`,
    ).then(
      (result) => result.deployments[0]?.versions[0]?.version_id ?? null,
      (error: unknown) => {
        console.warn(`kitshn: the version of ${row.script} is unknown: ${String(error)}`);
        return null;
      },
    );
    if (versionId === null)
      console.warn(`kitshn: no version of ${row.script} after the upload; no rollback to it.`);
    this.sql("UPDATE deploys SET version_id = ? WHERE id = ?", versionId, row.id);
    // The workers.dev address would skip Access. If it cannot be turned off, a new script goes away again.
    try {
      await api("POST", `${account}/workers/scripts/${row.script}/subdomain`, {
        enabled: false,
        previews_enabled: false,
      });
    } catch (error) {
      if (isNew)
        await api("DELETE", `${account}/workers/scripts/${row.script}?force=true`).catch(() => undefined);
      throw error;
    }
    await afterUpload();
    const addresses = rowAddresses(row);
    for (const address of addresses) {
      const domains = await api<Array<{ id: string; service: string }>>(
        "GET",
        `${account}/workers/domains?hostname=${encodeURIComponent(address)}`,
      );
      const attached = domains.find((domain) => domain.service === row.script);
      const endedBeforeAddress = this.endedRefusal(row.id);
      if (endedBeforeAddress) return endedBeforeAddress;
      if (attached) continue;
      if (domains.length > 0) throw new Error(`${address} already serves another Worker.`);
      const zone = zoneOfAddressIn(address, this.env);
      if (!zone) throw new Error(`kitshn does not publish on the zone of ${address} (K-1111).`);
      await api("PUT", `${account}/workers/domains`, {
        hostname: address,
        service: row.script,
        zone_id: zone.id,
        environment: "production",
      });
    }
    // K-817, K-410: an address that left the recipe loses its custom domain first, and its card address (with its
    // Access application) only after Cloudflare confirms that.
    await removeStaleDomains(api, account, row.script, addresses);
    // K-814: the route check records what a visitor without a login gets.
    const check = await fetch(`https://${row.address}/`, { redirect: "manual" }).catch(() => null);
    const resource = this.state.resources.get(row.resource_id);
    if (resource) this.putResource({ ...resource, addresses, status: "running" });
    this.sql("UPDATE deploys SET state = 'done' WHERE id = ? AND state = 'planned'", row.id);
    if (icon !== undefined) await this.setIcon(row.resource_id, icon);
    this.load();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ address: row.address, status: check?.status ?? 0, card });
  }

  /**
   * K-806: the crons that the other Workers of the account run, from one script list and the schedules of each
   * script with a scheduled handler. It runs in the storage step, before the upload, so the limit never fails a live
   * deploy. K-406: that step makes at most 11 calls for 10 KV bindings (one list and one create each), so this reads
   * at most 24 schedules and keeps the step at most 36 subrequests; with more such Workers, the deploy fails and says
   * so.
   */
  private async cronsOfOtherWorkers(api: Api, script: string): Promise<number> {
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    const scheduled = (
      await api<Array<{ id: string; handlers?: ReadonlyArray<string> }>>("GET", `${account}/workers/scripts`)
    ).filter((item) => item.id !== script && (item.handlers ?? []).includes("scheduled"));
    if (scheduled.length > 24)
      throw new RuleError(
        `${scheduled.length} Workers of the account have a scheduled handler; kitshn reads the crons of at most 24 in one deploy step (K-406).`,
      );
    let used = 0;
    for (const item of scheduled)
      used += (
        await api<{ schedules: ReadonlyArray<unknown> }>(
          "GET",
          `${account}/workers/scripts/${item.id}/schedules`,
        )
      ).schedules.length;
    return used;
  }

  /**
   * K-806: makes the KV namespace of each binding of the recipe that this environment does not have yet. A
   * namespace stays with the card across deploys, so its data stays too.
   */
  private async workerStorage(api: Api, row: DeployRow) {
    const app = workerOf(row);
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    if (this.deletingStorage.has(row.resource_id))
      return Response.json(
        {
          error: `kitshn deletes the storage of ${row.resource_id} now. Deploy again after it finishes (K-909).`,
        },
        { status: 409 },
      );
    const crons = isPreview(row.environment) ? [] : (app.crons ?? []);
    if (crons.length > 0) {
      const used = await this.cronsOfOtherWorkers(api, row.script);
      if (used + crons.length > CRON_LIMIT)
        return Response.json(
          {
            error: `Other Workers of the account run ${used} crons, and ${crons.length} more pass the limit of ${CRON_LIMIT} of the Free plan (K-806).`,
          },
          { status: 409 },
        );
    }
    const have = new Map(
      this.sql<{ name: string; cf_id: string }>(
        "SELECT name, cf_id FROM worker_storage WHERE card_id = ? AND kind = 'kv'",
        row.resource_id,
      ).map((item) => [item.name, item.cf_id]),
    );
    const bindings = app.kv ?? [];
    // One list of the namespaces: it shows a row whose namespace is gone (a delete that a restart cut off, or one
    // outside kitshn), and the namespace that an earlier run made before kitshn wrote its row. Known limit: it reads
    // the first 100 namespaces of the account only, and with a full page it trusts every row; revisit when the
    // account has more.
    const list =
      bindings.length === 0
        ? []
        : await api<Array<{ id: string; title: string }>>(
            "GET",
            `${account}/storage/kv/namespaces?per_page=100`,
          );
    const complete = list.length < 100;
    const created: Array<string> = [];
    for (const binding of bindings) {
      const known = have.get(binding);
      if (known !== undefined && (!complete || list.some((item) => item.id === known))) continue;
      const title = `kitshn-${row.resource_id}-${binding}`;
      const found = list.find((item) => item.title === title);
      const id = found
        ? found.id
        : (await api<{ id: string }>("POST", `${account}/storage/kv/namespaces`, { title })).id;
      this.sql(
        "INSERT OR REPLACE INTO worker_storage (card_id, kind, name, cf_id) VALUES (?, 'kv', ?, ?)",
        row.resource_id,
        binding,
        id,
      );
      created.push(binding);
    }
    return Response.json({ created });
  }

  /**
   * K-1113: one icon per card, written only when its bytes change (K-1302). With `hourly`, a stored icon changes
   * at most once an hour (K-1114). Returns whether the stored icon changed.
   */
  private async setIcon(
    id: string,
    icon: { readonly bytes: Uint8Array; readonly type: string } | null,
    hourly = false,
  ): Promise<boolean> {
    const now = Date.now();
    const hash = icon === null ? null : await iconHash(icon.bytes);
    if ((this.iconHashes.get(id) ?? null) === hash) return false;
    const changedAt = this.iconChangedAt.get(id);
    if (hourly && changedAt !== undefined && now - changedAt < ICON_CHANGE_MS) return false;
    if (icon === null || hash === null) {
      this.sql("DELETE FROM icons WHERE id = ?", id);
      this.iconHashes.delete(id);
      // A removal counts toward the hour too; its time lives in memory only, so a restart forgets it.
      this.iconChangedAt.set(id, now);
      return true;
    }
    this.sql(
      "INSERT OR REPLACE INTO icons (id, type, hash, bytes, changed_at) VALUES (?, ?, ?, ?, ?)",
      id,
      icon.type,
      hash,
      icon.bytes.slice().buffer,
      now,
    );
    this.iconHashes.set(id, hash);
    this.iconChangedAt.set(id, now);
    return true;
  }

  /** K-1114: the icon that a daemon read from one of its own sites. */
  private async liveIcon(machine: Machine, name: unknown, value: unknown) {
    const site = this.sitesOf(machine.id).find((item) => item.name === name);
    const icon = parseSiteIcon(value);
    if (!site || icon === undefined || typeof icon === "string") return;
    if (await this.setIcon(site.id, icon, true)) this.broadcast();
  }

  /** K-1113: the stored icon of a card. Its route sits behind the map's own check (K-104, K-208). */
  private icon(encodedId: string) {
    let id: string;
    try {
      id = decodeURIComponent(encodedId);
    } catch {
      return Response.json({ error: "The icon address is not valid." }, { status: 404 });
    }
    const [row] = this.sql<{ type: string; bytes: ArrayBuffer }>(
      "SELECT type, bytes FROM icons WHERE id = ?",
      id,
    );
    if (!row) return Response.json({ error: `kitshn has no icon for ${id}.` }, { status: 404 });
    return new Response(row.bytes, {
      headers: {
        "content-type": row.type,
        // The map asks with the hash in the address, so a new icon gets a new address.
        "cache-control": "private, max-age=86400",
        "x-content-type-options": "nosniff",
        // An SVG that someone opens on its own runs no script on the admin host.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  }

  /** K-904: a closed pull request removes its preview: the address, the Worker, the card and its Access app. */
  private async teardown(api: Api, row: DeployRow, deployer: Deployer) {
    await this.removeWorker(api, rowAddresses(row), row.script);
    // K-904, K-806: a closed preview takes its KV data with it; the script delete took its Durable Objects.
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    for (const { name, cf_id } of this.sql<{ name: string; cf_id: string }>(
      "SELECT name, cf_id FROM worker_storage WHERE card_id = ? AND kind = 'kv'",
      row.resource_id,
    )) {
      await api("DELETE", `${account}/storage/kv/namespaces/${cf_id}`).catch((error: unknown) =>
        error instanceof CloudflareError && error.status === 404 ? undefined : Promise.reject(error),
      );
      this.sql(
        "DELETE FROM worker_storage WHERE card_id = ? AND kind = 'kv' AND name = ?",
        row.resource_id,
        name,
      );
    }
    const resource = this.state.resources.get(row.resource_id);
    this.ctx.storage.transactionSync(() => {
      this.sql("DELETE FROM worker_storage WHERE card_id = ?", row.resource_id);
      const forgotten = this.forgetCard(row.resource_id);
      this.sql("UPDATE deploys SET state = 'done' WHERE id = ?", row.id);
      if (resource)
        this.insertRevision(
          { _tag: "kitshn", reason: `pull request closed in ${row.repo}, ${deployer.sha.slice(0, 7)}` },
          `Removed ${resource?.name ?? row.environment}, its preview closed (K-904)`,
          [forgotten],
          null,
        );
    });
    this.load();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ removed: row.address });
  }

  /** K-904, K-909: takes a Worker site's addresses off, confirms it, then deletes the Worker script. */
  private async removeWorker(api: Api, addresses: ReadonlyArray<string>, script: string) {
    await this.removeDomains(api, addresses, script);
    await api(
      "DELETE",
      `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${script}?force=true`,
    ).catch((error: unknown) =>
      error instanceof CloudflareError && error.status === 404 ? undefined : Promise.reject(error),
    );
  }

  /** K-909: takes the custom domains of a Worker off and confirms that each is gone. */
  private async removeDomains(api: Api, addresses: ReadonlyArray<string>, script: string) {
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    for (const address of addresses) {
      const domains = await api<Array<{ id: string; service: string }>>(
        "GET",
        `${account}/workers/domains?hostname=${encodeURIComponent(address)}`,
      );
      for (const domain of domains.filter((item) => item.service === script)) {
        await api("DELETE", `${account}/workers/domains/${domain.id}`);
      }
      // K-006: the card, and with it the Access application, goes only after each address is confirmed gone.
      const left = await api<Array<{ service: string }>>(
        "GET",
        `${account}/workers/domains?hostname=${encodeURIComponent(address)}`,
      );
      if (left.some((item) => item.service === script)) {
        throw new Error(`${address} still serves ${script}; run the teardown again.`);
      }
    }
  }

  /**
   * K-909: the undo of "Remove app" for a Worker app puts its addresses back on the script that the removal kept,
   * after their Access applications exist again (K-410). Its Durable Objects and KV kept their data.
   */
  private async reattachWorker(card: AppCard): Promise<string> {
    const back = `${card.name} is back on the map`;
    const done = this.lastDone(card.id);
    const refusal = this.state.paused
      ? "kitshn is paused, so it starts nothing until Resume."
      : this.closedPreview(card.id)
        ? "its pull request is closed, so the preview does not come back."
        : done
          ? this.repoRefusal(done.repo_id)
          : null;
    if (refusal) return `${back}, but kitshn did not put its addresses back: ${refusal}`;
    const api = this.api();
    if (!api) return `${back}, but kitshn has no Cloudflare API token here.`;
    const script = `kitshn-${card.id}`;
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    await this.syncAccessLocked(api, 20);
    for (const address of card.addresses) {
      const app = this.access.get(`app:${card.id}:${address}`);
      if (!app?.cfId || app.error)
        return `${back}, but the Access application of ${address} is not ready, so its addresses stay off. Deploy it again.`;
    }
    try {
      for (const address of card.addresses) {
        const domains = await api<Array<{ service: string }>>(
          "GET",
          `${account}/workers/domains?hostname=${encodeURIComponent(address)}`,
        );
        if (domains.some((domain) => domain.service === script)) continue;
        if (domains.length > 0) return `${back}, but ${address} now serves another Worker.`;
        const zone = zoneOfAddressIn(address, this.env);
        if (!zone) return `${back}, but kitshn does not publish on the zone of ${address} (K-1111).`;
        await api("PUT", `${account}/workers/domains`, {
          hostname: address,
          service: script,
          zone_id: zone.id,
          environment: "production",
        });
      }
    } catch (error) {
      return `${back}, but its addresses did not come back: ${error instanceof Error ? error.message : String(error)}. Deploy it again.`;
    }
    // The crons of the last deploy come back, as the removal took them off; a preview never had any.
    const crons = done?.app === "worker" && !isPreview(done.environment) ? (workerOf(done).crons ?? []) : [];
    try {
      if (crons.length > 0)
        await api(
          "PUT",
          `${account}/workers/scripts/${script}/schedules`,
          crons.map((cron) => ({ cron })),
        );
    } catch (error) {
      return `${back} at ${card.addresses.join(", ")}, but its crons did not come back: ${error instanceof Error ? error.message : String(error)}. Deploy it again.`;
    }
    this.sql("DELETE FROM worker_storage WHERE card_id = ? AND kind = 'script'", card.id);
    return `${back} at ${card.addresses.join(", ")}, with its data${crons.length > 0 ? " and its crons" : ""}.`;
  }

  /** A job that kitshn makes itself, so it needs no member with control (K-614). Returns the job id. */
  private queueKitshnJob(machineId: string, command: Command, actor: Actor, expiresAt: number) {
    const now = Date.now();
    if (
      command.kind === "compose" ||
      command.kind === "compose-redeploy" ||
      command.kind === "compose-rollback"
    )
      failQueuedDowns(this.query, command.project, REPLACED);
    const [row] = this.sql<{ id: number }>(
      `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, exit_code, output)
       VALUES (?, '[]', ?, 'queued', ?, ?, ?, '${KITSHN_JOB}', NULL, '') RETURNING id`,
      machineId,
      JSON.stringify(command),
      now,
      expiresAt,
      JSON.stringify(actor),
    );
    if (!row) throw new Error("The job insert returned no id.");
    return row.id;
  }

  /**
   * K-718: an agent key sees the cards that it manages and the circles that it is in (no members), moves
   * those cards between those circles, and runs jobs on the machines that it controls (K-614).
   */
  private async agentRequest(path: string, request: Request, caller: Caller) {
    const now = Date.now();
    const own = circlesOf(this.state, caller.visitor, now);
    if (own.size === 0)
      return Response.json(
        { error: "This key is in no agent circle, so it manages nothing (K-718)." },
        { status: 403 },
      );
    const managed = cardsControlledBy(this.state, caller.visitor, now);
    // K-614: the history names the device by its member name in its agent circle, not by its token id.
    const device = [...own]
      .flatMap((id) => this.state.circles.get(id)?.members ?? [])
      .find((member) => member._tag === "device" && member.clientId === caller.visitor.clientId);
    const agent: Caller =
      caller.actor._tag === "device" && device?._tag === "device"
        ? { ...caller, actor: { ...caller.actor, name: device.name } }
        : caller;
    const rights = AGENT_RIGHTS.filter((right) => agentHas(this.state, caller.visitor, right, now));
    // A key that publishes also sees the Everyone circle, where its published cards sit.
    const visible = (id: string) => {
      const circle = this.state.circles.get(id);
      return (
        own.has(id) || (rights.includes("publishes") && circle !== undefined && isEveryoneCircle(circle))
      );
    };
    // K-718: the cards of repos that this key allowed (K-819); only these may become public.
    const added = new Set(
      this.sql<{ resource_id: string }>(
        `SELECT DISTINCT deploys.resource_id FROM deploys JOIN repos ON repos.repo_id = deploys.repo_id AND deploys.kind = 'deploy'
         WHERE repos.allowed_by_client = ?`,
        caller.visitor.clientId,
      ).map((row) => row.resource_id),
    );
    const move = (edits: ReadonlyArray<Edit>) => {
      try {
        const changes = resolveEdits(this.state, edits);
        const refusal = agentRefusal(
          this.state,
          applyChanges(this.state, changes),
          caller.visitor,
          changes,
          now,
          added,
        );
        if (refusal) return Response.json({ error: refusal }, { status: 403 });
        return Response.json({ revision: this.commit(agent.actor, changes, null) });
      } catch (error) {
        if (error instanceof RuleError) return Response.json({ error: error.message }, { status: 409 });
        throw error;
      }
    };
    if (path === "/agent/state" && request.method === "GET") {
      return Response.json({
        rights,
        // K-819: with "may add apps", the waiting repos that the key may allow.
        repos: rights.includes("addsApps")
          ? this.sql<RepoRow>(
              "SELECT * FROM repos WHERE state = 'waiting' AND gone_at IS NULL ORDER BY first_seen DESC",
            ).map((row) => ({
              repoId: row.repo_id,
              name: row.name,
              branch: row.branch,
            }))
          : [],
        circles: [...this.state.circles.values()]
          .filter((circle) => visible(circle.id))
          .map(({ id, name, level, x, y, r }) => ({ id, name, level, x, y, r })),
        cards: [...managed].flatMap((id) => {
          const resource = this.state.resources.get(id);
          if (!resource) return [];
          const { kind, name, addresses, status } = resource;
          return [
            {
              id,
              kind,
              name,
              addresses,
              status,
              place: this.state.places.get(id) ?? null,
              added: added.has(id),
              circles: circlesHolding(this.state, id)
                .map((c) => c.id)
                .filter(visible),
            },
          ];
        }),
      });
    }
    if (path === "/agent/apply" && request.method === "POST") {
      let edits: ReadonlyArray<Edit>;
      try {
        const message = decodeClientMessage({
          ...((await request.json()) as object),
          type: "apply",
          requestId: "agent",
        });
        if (message.type !== "apply") throw new Error("Send edits.");
        edits = message.edits;
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
      return move(edits);
    }
    if (path === "/agent/publish" && request.method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      const card = isRecord(body) && typeof body["card"] === "string" ? body["card"] : null;
      const publish = isRecord(body) ? body["public"] : null;
      if (card === null || typeof publish !== "boolean")
        return Response.json({ error: 'Send {"card": <id>, "public": true | false}.' }, { status: 400 });
      if (!managed.has(card))
        return Response.json({ error: `This key has no control on the card "${card}".` }, { status: 403 });
      const place = publishPlace(this.state, caller.visitor, card, publish, now, added);
      if (typeof place === "string") return Response.json({ error: place }, { status: 409 });
      // The card is not in Everyone, so there is nothing to take out.
      if (place === null) return Response.json({ revision: null });
      return move([{ _tag: "place", id: card, after: place }]);
    }
    if (path === "/agent/jobs" && request.method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      const machineId =
        typeof body === "object" && body !== null && "machineId" in body ? body.machineId : undefined;
      // K-718, K-909: an agent key removes nothing, also no orphaned volume.
      const command = isRecord(body) && isRecord(body["command"]) ? body["command"] : null;
      if (command?.["kind"] === "compose-volume-remove")
        return Response.json(
          { error: "An agent key does not delete volumes (K-718, K-909)." },
          { status: 403 },
        );
      // Only the machines whose cards it manages; a label job could land on any machine.
      if (typeof machineId !== "string" || !agentMayRunOn(this.state, caller.visitor, machineId, Date.now()))
        return Response.json(
          {
            error:
              "An agent key runs jobs only on a machine whose card, and every card that runs on it, it manages (K-718).",
          },
          { status: 403 },
        );
      return this.addJob(agent, body);
    }
    if (path.startsWith("/agent/jobs/") && request.method === "GET") {
      const id = Number(path.slice("/agent/jobs/".length));
      const [row] = Number.isSafeInteger(id)
        ? this.sql<{ visitor: string }>("SELECT visitor FROM jobs WHERE id = ?", id)
        : [];
      const sender = row ? (JSON.parse(row.visitor) as Visitor).clientId : null;
      const [job] = sender !== null && sender === caller.visitor.clientId ? this.recentJobs(1, 4000, id) : [];
      // Only its own jobs: their state, exit code and output.
      if (!job) return Response.json({ error: `This key sent no job ${id}.` }, { status: 404 });
      return Response.json(job);
    }
    if (path.startsWith("/agent/repos/") && request.method === "POST") {
      // K-1504: the pause stops agent keys.
      if (this.state.paused)
        return Response.json(
          { error: "kitshn is paused (Emergency pause). Agent keys wait until Resume." },
          { status: 423 },
        );
      const repoId = decodeURIComponent(path.slice("/agent/repos/".length));
      const body: unknown = await request.json().catch(() => null);
      const [row] = this.sql<RepoRow>("SELECT * FROM repos WHERE repo_id = ?", repoId);
      const refusal = agentAllowRefusal(
        row ? repoGateOf(row) : undefined,
        isRecord(body) ? body["state"] : null,
        agentHas(this.state, caller.visitor, "addsApps", Date.now()),
        row?.gone_at !== null && row?.gone_at !== undefined,
      );
      if (refusal) return Response.json({ error: refusal.error }, { status: refusal.status });
      // An agent circle names this key, so its device member exists.
      if (device?._tag !== "device")
        throw new Error("An agent key without its device member allowed a repo.");
      return this.setRepoState(
        agent,
        repoId,
        { state: "allowed" },
        { clientId: device.clientId, name: device.name },
      );
    }
    if (path === "/agent/deploy" && request.method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      const card = isRecord(body) && typeof body["card"] === "string" ? body["card"] : null;
      const mode = isRecord(body) ? body["mode"] : null;
      if (card === null || (mode !== "redeploy" && mode !== "build"))
        return Response.json(
          { error: 'Send {"card": <id>, "mode": "redeploy" | "build"}.' },
          { status: 400 },
        );
      if (!cardsControlledBy(this.state, caller.visitor, Date.now()).has(card))
        return Response.json({ error: `This key has no control on the card "${card}".` }, { status: 403 });
      const row = this.lastDone(card);
      const machine = row?.machine_id ? this.state.machines.get(row.machine_id) : undefined;
      const plan = agentDeployPlan(
        row ? this.lastDeployOf(row) : null,
        mode,
        machine ? this.redeployFacts(machine, card, row?.repo ?? "") : null,
      );
      if (plan.kind === "refused") return Response.json({ error: plan.error }, { status: plan.status });
      const repoId = row?.repo_id ?? null;
      const refusal = this.repoRefusal(repoId);
      if (refusal !== null || repoId === null) return Response.json({ error: refusal }, { status: 403 });
      if (plan.kind === "build")
        return this.agentBuild(agent, repoId, plan.branch, row?.workflow ?? AGENT_WORKFLOW);
      if (!machine) return Response.json({ error: "The machine of this app is gone." }, { status: 409 });
      return this.agentRedeploy(agent, machine.id, plan.command);
    }
    return Response.json({ error: `The agent path has no ${request.method} ${path}.` }, { status: 404 });
  }

  /** K-718: why a machine may not start the last good build of a card now, or null. */
  private redeployRefusal(machineId: string | null, card: string) {
    const machine = machineId === null ? undefined : this.state.machines.get(machineId);
    if (!machine || this.state.resources.get(card)?.machine !== machine.id)
      return "This app no longer runs on the machine of its last deploy.";
    return machine.labels.includes("deploy")
      ? null
      : "The machine of this app no longer has the label deploy (K-610).";
  }

  /** K-718: queues the start of the last build that came up; kitshn makes the job, the key reads it. */
  private agentRedeploy(
    caller: Caller,
    machineId: string,
    command: Extract<Command, { kind: "compose-redeploy" }>,
  ) {
    const now = Date.now();
    const id = this.ctx.storage.transactionSync(() => {
      failQueuedDowns(this.query, command.project, REPLACED);
      const [inserted] = this.sql<{ id: number }>(
        `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, exit_code, output)
         VALUES (?, '[]', ?, 'queued', ?, ?, ?, ?, NULL, '') RETURNING id`,
        machineId,
        JSON.stringify(command),
        now,
        now + DEPLOY_MS,
        JSON.stringify(caller.actor),
        JSON.stringify({ ...caller.visitor, kitshn: true }),
      );
      this.insertRevision(caller.actor, `Redeployed the last good build of ${command.name}`, [], null);
      return inserted?.id ?? null;
    });
    this.load();
    this.deliverJobs();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ job: id });
  }

  /** K-718, K-812, K-819: a new build runs the kitshn workflow of the repo with this id on one branch. */
  private async agentBuild(caller: Caller, repoId: string, branch: string, workflow = AGENT_WORKFLOW) {
    if (!this.env.GITHUB_APP_ID || !this.env.GITHUB_APP_KEY)
      return Response.json({ error: NO_GITHUB_APP }, { status: 503 });
    let repo: string;
    try {
      repo = await this.dispatchBuild(repoId, branch, workflow);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 502 },
      );
    }
    this.ctx.storage.transactionSync(() =>
      this.insertRevision(caller.actor, `Started a deploy of ${repo} from ${branch}`, [], null),
    );
    this.load();
    this.broadcast();
    return Response.json({ dispatched: { repo, branch, workflow } });
  }

  /** K-718, K-908, K-909: runs the kitshn workflow of a repo on one branch. Returns the repo's current name. */
  private async dispatchBuild(repoId: string, branch: string, workflow = AGENT_WORKFLOW) {
    const appId = this.env.GITHUB_APP_ID;
    const key = this.env.GITHUB_APP_KEY;
    if (!appId || !key) throw new Error(NO_GITHUB_APP);
    const repo = await dispatchDeploy({ id: appId, key }, repoId, branch, workflow);
    this.sql("UPDATE repos SET name = ?, gone_at = NULL WHERE repo_id = ?", repo, repoId);
    return repo;
  }

  private libraryItems(): Array<LibraryItem> {
    return this.sql<LibraryRow>("SELECT * FROM library ORDER BY created_at DESC").map(libraryItem);
  }

  /** K-1004: the Worker asks here before it serves a page or a file. */
  private contentDecision({ id, visitor: sent }: ContentRequest) {
    const signedOutAt = Number(this.meta("signed_out_at") ?? 0);
    const visitor: ContentVisitor =
      (sent.email !== null || sent.clientId !== null) && (sent.issuedAt ?? 0) * 1000 < signedOutAt
        ? { email: null, clientId: null, ip: sent.ip, passkey: false, issuedAt: null }
        : sent;
    // The old cookie still opens the login path, so the Worker drops it, or the login sends the visitor
    // straight back with it.
    const stale = visitor !== sent;
    const [row] = this.sql<LibraryRow>("SELECT * FROM library WHERE id = ?", id);
    const resource = this.state.resources.get(id);
    if (!row || !resource) return Response.json({ decision: "missing", stale });
    const decision = contentAccess(this.state, resource, visitor, Date.now());
    return Response.json(
      decision === "allow" ? { decision, item: libraryItem(row), stale } : { decision, stale },
    );
  }

  /**
   * K-1101, K-1002: puts a page or a file into R2 and its card into the tray. The metadata comes in
   * URI-encoded headers. An import names a `source`, and a second upload of the same source changes nothing.
   */
  private async upload(caller: Caller, request: Request, kind: "page" | "file") {
    const header = (name: string) => {
      const value = request.headers.get(name);
      if (value === null) return null;
      try {
        return decodeURIComponent(value).trim();
      } catch {
        throw new RuleError(`${name} is not URI-encoded.`);
      }
    };
    const refuse = (error: string, status = 400) => Response.json({ error }, { status });
    const bucket = this.env.BUCKET;
    if (!bucket) return refuse("R2 is off for this kitshn. Run the bootstrap again after R2 is on.", 503);
    const size = Number(request.headers.get("content-length"));
    if (!request.body || !Number.isInteger(size) || size <= 0)
      return refuse("Send the bytes with a Content-Length.", 411);
    if (size > MAX_UPLOAD_BYTES) return refuse("A page or a file is at most 100 MB (K-1101).", 413);
    const name = header("x-kitshn-name") ?? "";
    if (kind === "file") {
      const error = fileNameError(name);
      if (error) return refuse(error);
    }
    const title = (kind === "page" ? name : (header("x-kitshn-title") ?? name)).slice(0, 200);
    if (title === "") return refuse("Give the page a title in X-Kitshn-Name.");
    const source = header("x-kitshn-source");
    if (source) {
      const [known] = this.sql<{ id: string }>(
        "SELECT id FROM library WHERE source = ? UNION ALL SELECT '' FROM library_deleted WHERE source = ?",
        source,
        source,
      );
      // An import adds a page once (K-1008), and never again after a delete in the Library.
      if (known) return Response.json(known.id ? { id: known.id, existing: true } : { deleted: true });
    }
    const createdAt = Number(header("x-kitshn-created-at") ?? Date.now());
    if (!Number.isFinite(createdAt) || createdAt <= 0)
      return refuse("X-Kitshn-Created-At is not a time in ms.");
    // A file dropped on the map lands where it was dropped, and so in the circles there (K-204).
    const [x, y] = [header("x-kitshn-x"), header("x-kitshn-y")].map((value) =>
      value === null ? null : value === "" ? Number.NaN : Number(value),
    );
    const place =
      x === null || y === null || x === undefined || y === undefined
        ? null
        : Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 1e6 && Math.abs(y) < 1e6
          ? { x: Math.round(x), y: Math.round(y) }
          : undefined;
    if (place === undefined) return refuse("X-Kitshn-X and X-Kitshn-Y are not a point on the map.");
    const item: LibraryItem = {
      id: newLibraryId(),
      kind,
      title,
      fileName: kind === "file" ? name : null,
      thread: header("x-kitshn-thread") || null,
      machine: header("x-kitshn-machine") || null,
      size,
      contentType:
        kind === "page" ? "text/html" : request.headers.get("content-type") || "application/octet-stream",
      createdAt,
    };
    // K-1115: a page may hold a data: icon, and a small file may be an image; read their start beside R2.
    const [body, sniffed] =
      kind === "page" || size <= ICON_LIMIT ? request.body.tee() : ([request.body, null] as const);
    // The icon comes first, before any R2 write, so a CPU limit while it decodes leaves no object behind.
    const head = sniffed ? await readStart(sniffed, kind === "page" ? PAGE_ICON_SCAN : ICON_LIMIT) : null;
    const iconBytes =
      head === null ? null : kind === "page" ? pageDataIcon(new TextDecoder().decode(head)) : head;
    const iconKind = iconBytes !== null && iconBytes.length <= ICON_LIMIT ? iconType(iconBytes) : null;
    // The stream fails when the body is not exactly Content-Length bytes, so the limit holds.
    const { readable, writable } = new FixedLengthStream(size);
    const piped = body.pipeTo(writable);
    try {
      await bucket.put(objectKey(item), readable, { httpMetadata: { contentType: item.contentType } });
      await piped;
    } catch (error) {
      await piped.catch(() => undefined);
      return refuse(`The upload did not reach R2: ${String(error)}`, 502);
    }
    const resource: Resource = {
      id: item.id,
      kind,
      name: title,
      addresses: [
        kind === "page"
          ? `pages.${this.env.KITSHN_ZONE}/${item.id}`
          : `files.${this.env.KITSHN_ZONE}/${item.id}/${encodeURIComponent(name)}`,
      ],
      status: "running",
      group: null,
      machine: null,
    };
    const record = () =>
      this.ctx.storage.transactionSync(() => {
        this.sql(
          `INSERT INTO library (id, kind, title, file_name, thread, machine, size, content_type, created_at, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          item.id,
          item.kind,
          item.title,
          item.fileName,
          item.thread,
          item.machine,
          item.size,
          item.contentType,
          item.createdAt,
          source,
        );
        this.putResource(resource);
        if (!place)
          return this.insertRevision(caller.actor, `Added the ${kind} ${title} to the tray`, [], null);
        // The UI asks before a drop makes a card public (K-210); an agent tool must ask the same way (K-715).
        const changes: Array<Change> = [{ _tag: "place", id: item.id, before: null, after: place }];
        this.persist(changes);
        return this.insertRevision(caller.actor, `Added the ${kind} ${title} on the map`, changes, null);
      });
    let revision: number;
    try {
      revision = record();
    } catch (error) {
      // No card names the object, so it goes too (K-1115).
      await bucket.delete(objectKey(item)).catch(() => undefined);
      throw error;
    }
    if (iconBytes !== null && iconKind !== null)
      await this.setIcon(item.id, { bytes: iconBytes, type: iconKind });
    this.load();
    this.broadcast();
    return Response.json({ id: item.id, address: resource.addresses[0], revision }, { status: 201 });
  }

  /**
   * K-1005: the preview of the Library view, for the admin only. The sandbox header gives it an opaque
   * origin, so a page cannot read the admin cookie or call the API.
   */
  private async preview(id: string) {
    const [row] = this.sql<LibraryRow>("SELECT * FROM library WHERE id = ?", id);
    const object = row && (await this.env.BUCKET?.get(objectKey(libraryItem(row))));
    if (!row || !object) return new Response("kitshn has no such item.", { status: 404 });
    return new Response(object.body, {
      headers: {
        "content-type": row.kind === "page" ? "text/html; charset=utf-8" : row.content_type,
        "content-security-policy": contentSecurityPolicy(this.env.KITSHN_HOST),
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  }

  /** K-1006: removes the bytes from R2 first, then the card and the index row. */
  private async deleteItem(caller: Caller, id: string) {
    const [row] = this.sql<LibraryRow>("SELECT * FROM library WHERE id = ?", id);
    if (!row) return Response.json({ error: `The library has no item ${id}.` }, { status: 404 });
    const item = libraryItem(row);
    if (!this.env.BUCKET) return Response.json({ error: "R2 is off for this kitshn." }, { status: 503 });
    await this.env.BUCKET.delete(objectKey(item));
    this.ctx.storage.transactionSync(() => {
      this.sql(
        "INSERT OR IGNORE INTO library_deleted (source) SELECT source FROM library WHERE id = ? AND source IS NOT NULL",
        id,
      );
      this.sql("DELETE FROM library WHERE id = ?", id);
      this.insertRevision(
        caller.actor,
        `Deleted the ${item.kind} ${item.title}`,
        [this.forgetCard(id)],
        null,
      );
    });
    this.load();
    this.broadcast();
    return Response.json({ deleted: id });
  }

  /** K-113: returns the Cloudflare calls it made. */
  private async syncLauncher(api: Api, force: boolean) {
    if (!force && this.meta("launcher_failed") === `failed:${this.launcherWant()}`) return 0;
    try {
      const result = await syncLauncher(
        this.desired(Date.now()),
        this.accessStore(),
        api,
        this.env.CLOUDFLARE_ACCOUNT_ID,
        this.meta("launcher_policy") || null,
        force,
      );
      this.setMeta("launcher_policy", result.attached ?? "");
      this.setMeta("launcher_failed", "none");
      return result.calls;
    } catch (error) {
      // K-408: a failed write waits for the daily retry, so the alarm does not loop on it.
      console.warn(`kitshn could not update the App Launcher: ${String(error)}`);
      this.setMeta("launcher_failed", `failed:${this.launcherWant()}`);
      return 3;
    }
  }

  /** K-113: the enrollment policy id that the App Launcher should have, or "" for none. */
  private launcherWant() {
    return this.desired(Date.now()).policies.has(ENROLLMENT_KEY)
      ? this.access.get(ENROLLMENT_KEY)?.cfId || ""
      : "";
  }

  /** K-113: the App Launcher lacks the wanted policy, and that change did not fail since the daily retry. */
  private launcherWork() {
    const want = this.launcherWant();
    return want !== (this.meta("launcher_policy") ?? "") && this.meta("launcher_failed") !== `failed:${want}`;
  }

  /** K-1004: returns the Cloudflare calls it made. The daily run (K-408) asks it to write everything again. */
  private async syncLogins(api: Api) {
    const desired = this.desired(Date.now());
    const want = loginWant(desired, this.access);
    const force = this.meta("login_check") === "due";
    this.setMeta("login_check", "done");
    try {
      const result = await syncLogins(
        desired,
        this.accessStore(),
        api,
        this.env.CLOUDFLARE_ACCOUNT_ID,
        this.env.KITSHN_ZONE,
        this.meta("login_policies") ?? "",
        force,
      );
      this.setMeta("login_policies", result.attached);
      this.setMeta("login_held", result.attached);
      this.setMeta("login_failed", "none");
      this.setLoginError("");
      return result.calls;
    } catch (error) {
      // K-408: a failed write waits for the daily retry, so the alarm does not loop on it.
      console.warn(String(error));
      this.setMeta("login_failed", `failed:${want}`);
      this.setMeta("login_held", loginHeldAfter(this.meta("login_held") ?? "", want, false));
      this.setLoginError(error instanceof Error ? error.message : String(error));
      return LOGIN_CALLS;
    }
  }

  /** K-1004: the map shows a failed login update next to the other Access warnings. */
  private setLoginError(text: string) {
    if ((this.meta("login_error") ?? "") === text) return;
    this.setMeta("login_error", text);
    this.broadcast();
  }

  /** K-406, K-1004: every Access sync runs here, after the login step, inside one budget. */
  private syncAccessLocked(api: Api, budget: number) {
    return this.withAccessLock(() =>
      syncWithLogins(
        budget,
        this.loginWork(),
        () => this.syncLogins(api),
        (left) =>
          syncAccess(
            this.desired(Date.now()),
            this.accessStore(),
            api,
            this.env.CLOUDFLARE_ACCOUNT_ID,
            left,
            this.reachableAddresses(),
            // Read after the login step, which may have let go of some.
            loginHeld(this.meta("login_held") ?? ""),
          ),
      ),
    );
  }

  /** K-1004: the daily check is due, or the login applications lack the wanted policies and that did not fail. */
  private loginWork() {
    if (this.meta("login_check") === "due") return true;
    const want = loginWant(this.desired(Date.now()), this.access);
    return want !== (this.meta("login_policies") ?? "") && this.meta("login_failed") !== `failed:${want}`;
  }

  private accessLock: Promise<unknown> = Promise.resolve();
  /** K-603: when the alarm reads missing audience tags again. In memory: a restart only reads sooner. */
  private audRetryAt = 0;

  /** K-603: reads missing audience tags before the tunnels use them. Returns the number of calls. */
  private async fillAudiences(api: Api, now: number) {
    if (rowsWithoutAud(this.access).length === 0 || this.audRetryAt > now) return 0;
    try {
      // In the lock, so a deploy's Access sync never writes a row between the read and the put.
      return await this.withAccessLock(() =>
        fillAudiences(this.accessStore(), api, this.env.CLOUDFLARE_ACCOUNT_ID),
      );
    } catch (error) {
      console.warn(`kitshn could not read the audience tags of Access: ${String(error)}`);
      return 1;
    } finally {
      if (rowsWithoutAud(this.access).length > 0) this.audRetryAt = now + RETRY_MS;
    }
  }

  /** Runs one Access sync at a time, so a deploy and the alarm never both create the same object. */
  private withAccessLock<T>(work: () => Promise<T>): Promise<T> {
    const run = this.accessLock.then(work, work);
    this.accessLock = run.catch(() => undefined);
    return run;
  }

  private accessStore(): AccessStore {
    return {
      rows: this.access,
      put: (row: AccessRow) => {
        this.access.set(row.key, row);
        this.sql(
          "INSERT OR REPLACE INTO access_objects (key, cf_id, aud, body, tried, error) VALUES (?, ?, ?, ?, ?, ?)",
          row.key,
          row.cfId,
          row.aud,
          row.body,
          row.tried,
          row.error,
        );
      },
      remove: (key: string) => {
        this.access.delete(key);
        this.sql("DELETE FROM access_objects WHERE key = ?", key);
      },
    };
  }

  /** The Cloudflare API with the Worker's token, or a reason when the Worker has none (local development). */
  private api() {
    const token = this.env.CLOUDFLARE_API_TOKEN;
    if (!token) return null;
    return <T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) =>
      cloudflare<T>(token, method, path, body);
  }

  override async alarm() {
    const now = Date.now();
    this.checkLiveness(now);
    // The alarm runs every 30 s while a daemon is connected, so it tells the maps only about real changes.
    let changed = this.expireJobs(now) > 0;
    if (this.settleRollbacks() > 0) changed = true;
    const before = JSON.stringify(accessStates(this.desired(now), this.access));
    this.endShares(now);
    const daily = this.dailyAt() <= now;
    if (daily) this.daily(now);
    const api = this.api();
    if (api) {
      const desired = this.desired(now);
      // K-406: the daily compare spends part of the 40 calls of this run.
      let spent = 0;
      if (daily) {
        try {
          this.accessWarnings = await verifyAccess(
            desired,
            this.accessStore(),
            api,
            this.env.CLOUDFLARE_ACCOUNT_ID,
          );
          spent += 2;
          spent += await verifyPasskeys(this.accessStore(), api, this.env.CLOUDFLARE_ACCOUNT_ID, 10);
          this.setMeta("access_warnings", JSON.stringify(this.accessWarnings));
        } catch (error) {
          console.warn(`kitshn could not compare Access with the shares: ${String(error)}`);
          spent = 12;
        }
      }
      spent += await this.fillAudiences(api, now);
      // Removals first: ingress and DNS go before an Access application does. Additions wait for the next
      // run, because ingress and DNS need the application that the Access sync makes (K-410).
      await this.syncTunnels(api, 6);
      spent += await this.checkSites(api, 6);
      await this.syncDns(api, 5);
      await this.syncRoutes(api, 5);
      // K-113: take an unwanted enrollment policy off the App Launcher before the sync deletes it.
      spent += await this.syncLauncher(api, daily);
      // K-406: at most 40 calls. `spent` counts the daily compare (12), the site checks (6) and the launcher
      // step (3); the tunnels, DNS records and offline routes above made at most 6 + 5 + 5, and the launcher
      // step after the sync needs 3. The login step and the sync share what is left. A policy that the sync
      // makes goes on the login applications in the next alarm, which runs at once (loginWork).
      await this.syncAccessLocked(api, CALLS_PER_RUN - spent - 16 - 3);
      // A policy that the sync just made goes on the App Launcher in the same run.
      await this.syncLauncher(api, false);

      changed ||= daily || JSON.stringify(accessStates(this.desired(now), this.access)) !== before;
    }
    if (changed) this.broadcast();
    await this.scheduleAlarm();
  }
}

/** OWNER_DEVICES: a JSON list of `{ tokenId, clientId, name }` that join the Owner circle at setup (K-106). */
function ownerDevices(text: string | undefined): Array<Extract<Member, { _tag: "device" }>> {
  if (!text) return [];
  const list = JSON.parse(text) as unknown;
  if (!Array.isArray(list)) throw new Error("OWNER_DEVICES is not a JSON list.");
  return list.map((item: unknown) => {
    const device = item as Partial<Record<"tokenId" | "clientId" | "name", unknown>>;
    if (
      typeof device.tokenId !== "string" ||
      typeof device.clientId !== "string" ||
      typeof device.name !== "string"
    ) {
      throw new Error("Each OWNER_DEVICES item needs tokenId, clientId and name.");
    }
    return { _tag: "device", tokenId: device.tokenId, clientId: device.clientId, name: device.name };
  });
}

/** The output of a job whose machine went offline; a later real result replaces it. */
const OFFLINE_OUTPUT = "The machine went offline during the job. kitshn takes its result if it comes later.";

interface RepoRow extends Record<string, SqlStorageValue> {
  repo_id: string;
  name: string;
  state: RepoState;
  first_seen: number;
  branch: string | null;
  /** K-1121: the workflow file of the run that waits on `branch`. */
  workflow: string | null;
  allowed_by_client: string | null;
  allowed_by_name: string | null;
  /** K-819: when kitshn last got an answer from GitHub about this repo id. */
  checked_at: number | null;
  /** K-819: since when GitHub answers that the repo id no longer exists; null while it exists. */
  gone_at: number | null;
}

const repoGateOf = (row: RepoRow): RepoGate => ({
  repoId: row.repo_id,
  name: row.name,
  state: row.state,
  firstSeen: row.first_seen,
  branch: row.branch,
  workflow: row.workflow,
  allowedBy:
    row.allowed_by_client === null
      ? null
      : { clientId: row.allowed_by_client, name: row.allowed_by_name ?? "" },
});

interface DeployRow extends Record<string, SqlStorageValue> {
  id: string;
  repo: string;
  /** K-819: GitHub's id of the repo; null only for an old row whose card id holds none. */
  repo_id: string | null;
  environment: string;
  resource_id: string;
  address: string;
  script: string;
  starts_in: string | null;
  kind: "deploy" | "teardown";
  sha: string;
  state: string;
  expires_at: number;
  app: "static" | "compose" | "worker";
  machine_id: string | null;
  job_id: number | null;
  compose_file: string | null;
  /** The branch that the deploy came from (K-807). */
  branch: string;
  /** K-817: every address that serves the environment, the main one first, as JSON; null on older rows. */
  addresses: string | null;
  /** K-806: the `worker` part of the recipe as JSON, for a Worker app. */
  worker: string | null;
  /** K-804: the app of the repo; older rows are the app `app`. */
  app_key: string;
  /** K-820: why the deploy failed or did not run. */
  reason: string | null;
  /** K-820: the Cloudflare version of a static or Worker deploy, and the run that deployed it. */
  version_id: string | null;
  run_id: string | null;
  run_attempt: string | null;
  /** K-821: the image ids of a Compose deploy that came up, and the `needs.apps` keys, as JSON. */
  images: string | null;
  needs: string | null;
  /** K-821: the deploy whose build this rollback row repeats; null on a row that a workflow run made. */
  origin: string | null;
  /** K-1121: the workflow file of the run that made the deploy; null starts `kitshn.yml`. */
  workflow: string | null;
}

/** K-821: one finished deploy of a card in the rollback list; `why` says why a rollback cannot go there. */
interface RollbackChoice {
  readonly deployId: string;
  readonly sha: string;
  readonly at: number;
  readonly run: string | null;
  readonly note: string | null;
  readonly why: string | null;
}

/** K-821: one card of a run rollback and the deploy that it goes back to. */
interface RunRollbackStep {
  readonly card: string;
  readonly name: string;
  readonly deployId: string | null;
  readonly sha: string | null;
  readonly why: string | null;
}

/** K-806: the crons of the Free plan per account. */
const CRON_LIMIT = 5;

/** K-806: the Worker part of the recipe that the plan of a Worker deploy stored. */
function workerOf(row: DeployRow): typeof WorkerApp.Type {
  if (row.app !== "worker" || row.worker === null)
    throw new Error(`The deploy ${row.id} is not a Worker deploy.`);
  return decodeWorkerApp(JSON.parse(row.worker));
}

const decodeWorkerApp = Schema.decodeUnknownSync(WorkerApp);

/** K-817: the addresses of a deploy row, the main one first. */
function rowAddresses(row: Pick<DeployRow, "address" | "addresses">): Array<string> {
  if (!row.addresses) return [row.address];
  const parsed: unknown = JSON.parse(row.addresses);
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((item) => typeof item === "string"))
    throw new Error(`The addresses of the deploy of ${row.address} are not a list of names.`);
  return parsed;
}

/** A failed tunnel, DNS or route write tries again after this time. */
const RETRY_MS = 5 * 60_000;

const DAY_MS = 24 * 3_600_000;

/** K-819: GitHub calls of one repo check; a Free plan request may make 50 subrequests. */
const GITHUB_CALLS_PER_CHECK = 40;

/** A machine as the actor of what its daemon does, such as a key rotation (K-1705). */
const deviceActor = (machine: Machine): Actor => ({
  _tag: "device",
  clientId: machine.clientId,
  name: machine.name,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const send = (socket: WebSocket, message: ServerMessage | ServerToDaemon) =>
  socket.send(JSON.stringify(message));

interface ContentRequest {
  readonly id: string;
  readonly visitor: ContentVisitor;
}

interface LibraryRow extends Record<string, SqlStorageValue> {
  id: string;
  kind: string;
  title: string;
  file_name: string | null;
  thread: string | null;
  machine: string | null;
  size: number;
  content_type: string;
  created_at: number;
}

const libraryItem = (row: LibraryRow): LibraryItem => ({
  id: row.id,
  kind: row.kind === "file" ? "file" : "page",
  title: row.title,
  fileName: row.file_name,
  thread: row.thread,
  machine: row.machine,
  size: row.size,
  contentType: row.content_type,
  createdAt: row.created_at,
});

/** The R2 key of a file of a Compose deploy (K-812). */
const deployObject = (deployId: string, file: string) => `deploys/${deployId}/${file}`;

/** The requester of a job that kitshn makes itself, such as a deploy (K-614). */

/** K-1504: who paused and when, from the meta rows that a pause writes. */
function parsePausedBy(
  actor: string | null,
  at: string | null,
): { readonly actor: Actor; readonly at: number } | null {
  if (!actor || !at) return null;
  return { actor: JSON.parse(actor) as Actor, at: Number(at) };
}

const KITSHN_JOB = JSON.stringify({ email: null, clientId: null, ip: null, kitshn: true });

/** K-718: the workflow file that an agent key starts in an app repo, the one that the map's recipe shows. */
const AGENT_WORKFLOW = "kitshn.yml";
/** K-909: the expiry of a job that waits for its machine however long. */
const NEVER = Number.MAX_SAFE_INTEGER;
const NO_GITHUB_APP =
  "This kitshn has no GitHub App. Run the bootstrap with KITSHN_GITHUB_APP_ID and KITSHN_GITHUB_APP_KEY.";

/** K-1114: a daemon changes the stored icon of a site at most once in this time. */
const ICON_CHANGE_MS = 60 * 60_000;

/** K-1113: the short hash of icon bytes, which versions the icon address. */
async function iconHash(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** K-1115: how much of a page kitshn reads for a data: icon; a 100 KB icon is about 137 KB as base64. */
const PAGE_ICON_SCAN = 256 * 1024;

/** The first `limit` bytes of a stream, or all of a shorter one; it stops reading after that. */
async function readStart(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes.subarray(0, limit);
}
