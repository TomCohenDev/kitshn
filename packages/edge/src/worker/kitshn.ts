import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";
import { ACCESS_NAME_PREFIX, ENROLLMENT_KEY, desiredAccess } from "../core/access.ts";
import { type DownJob, appRestart, appTeardown, composeUndo, orphanVolumes } from "../core/apps.ts";
import {
  type Actor,
  type AppCard,
  type Change,
  type Edit,
  RuleError,
  applyChanges,
  conflictOf,
  deepEqual,
  invert,
  refuseRaiseWhilePaused,
  refuseResume,
  removeAppChanges,
  resolveEdits,
  restoredResource,
  ruleViolation,
  shareDiff,
  stacksWithout,
  summarize,
  withStackMates,
} from "../core/changes.ts";
import {
  ADMIN_RESOURCE_ID,
  AGENT_RIGHTS,
  isPublicCircle,
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
  type MachineStatus,
  type ProjectVolume,
  type Sample,
  type ServerToDaemon,
  allowedFor,
  parseAllowances,
  joinLookup,
  newJoinCode,
  sealJoin,
} from "../core/machine.ts";
import { placeInside } from "../core/place.ts";
import type { MachineView, RepoView, RevisionView, ServerMessage, Snapshot } from "../core/protocol.ts";
import {
  type AllowingAgent,
  type RepoGate,
  type RepoState,
  agentAllowRefusal,
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
  mayDeployOn,
  publishPlace,
} from "../core/agent.ts";
import { demo } from "../core/demo.ts";
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
  signOutEverywhere,
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
import { dispatchDeploy } from "./github.ts";
import { REPO_GATE_MIGRATION, migrate } from "./migrations.ts";
import {
  DEPLOY_MS,
  SCRIPT_LIMIT,
  STATIC_WORKER,
  environmentNames,
  eventOf,
  legacyRepos,
  parseManifest,
} from "./deploys.ts";
import { type Recipe, decodeRecipe, plan, repoSlug } from "kitshn/recipe";
import {
  type LiveSite,
  ingressAccess,
  liveSiteId,
  reachableAddresses,
  offlineReason,
  parseSites,
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
  pickMachine,
} from "./machines.ts";
import type { Env } from "./env.ts";

/** What a WebSocket of this Durable Object belongs to. */
type Attachment =
  | { readonly kind: "map"; readonly caller: Caller }
  | {
      readonly kind: "machine";
      readonly machineId: string;
      readonly since: number;
      /** K-605, K-606: kept on the socket, so they survive hibernation and cost no row writes. */
      readonly status: MachineStatus | null;
      readonly sample: Sample | null;
      /** K-909: the idle volumes of kitshn apps; a socket from before this field has none. */
      readonly volumes?: ReadonlyArray<ProjectVolume>;
    };

/** The map keeps this many recent revisions in memory; History reads them (K-519). */
const RECENT_REVISIONS = 200;
/** K-1503 */
const REVISION_DAYS = 90;
const REVISION_COUNT = 5000;
const DAY = 24 * 60 * 60 * 1000;

const nextUtcMidnight = (now: number) => Math.floor(now / DAY) * DAY + DAY;

const decodeClientMessage = Schema.decodeUnknownSync(ClientMessage);

/** K-003: the one Durable Object. It holds all state in SQLite and a copy in memory. */
export class Kitshn extends DurableObject<Env> {
  private state!: State;
  private revisions: Array<RevisionView> = [];
  private access = new Map<string, AccessRow>();
  /** Expired shares whose card has no place outside the circle. Retried once after each restart. */
  private stuckShares = new Set<string>();
  private accessWarnings: Array<string> = [];
  /** K-606: presence is stored on change; status and the latest sample live on the socket. */
  private presence = new Map<string, { online: boolean; lastSeen: number }>();
  /** K-1104: live sites of the machines. */
  private liveSites = new Map<string, LiveSite>();
  /** Address checks that failed, and when to try them again. Memory only; a restart retries at once. */
  private checkRetryAt = new Map<string, number>();

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
      await this.scheduleAlarm();
    });
  }

  private sql<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: Array<SqlStorageValue>) {
    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
  }

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
      this.sql<{ id: string; online: number; last_seen: number }>(
        "SELECT id, online, last_seen FROM presence",
      ).map((row) => [row.id, { online: row.online === 1, lastSeen: row.last_seen }]),
    );
    this.accessWarnings = JSON.parse(this.meta("access_warnings") ?? "[]") as Array<string>;
    this.access = new Map(
      this.sql<{ key: string; cf_id: string; aud: string; body: string; tried: string; error: string | null }>(
        "SELECT key, cf_id, aud, body, tried, error FROM access_objects",
      ).map((row) => [
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
    }>(
      "SELECT id, at, actor, summary, undoes, changes = '[]' AS empty FROM revisions ORDER BY id DESC LIMIT ?",
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
      // The local demo shows the repo gate (K-819): one repo that deploys, one that waits.
      if (extra.resources.length > 0)
        for (const [id, name, state] of [
          ["1001", "Yarden-zamir/riffle", "allowed"],
          ["1002", "Yarden-zamir/new-app", "waiting"],
        ] as const)
          this.sql(
            "INSERT OR IGNORE INTO repos (repo_id, name, state, first_seen) VALUES (?, ?, ?, ?)",
            id,
            name,
            state,
            Date.now(),
          );
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
    changes: ReadonlyArray<Change>,
    undoes: number | null,
  ) {
    const [row] = this.sql<{ id: number }>(
      "INSERT INTO revisions (at, actor, summary, changes, undoes) VALUES (?, ?, ?, ?, ?) RETURNING id",
      Date.now(),
      JSON.stringify(actor),
      summary,
      JSON.stringify(changes),
      undoes,
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

  /** One write: checks the rules (K-105), stores the changes and one revision (K-1501), then tells everyone. */
  private commit(actor: Actor, changes: ReadonlyArray<Change>, undoes: number | null): number | null {
    if (changes.length === 0) return null;
    const before = this.state;
    const after = this.checked(changes);
    const summary =
      undoes === null
        ? summarize(before, after, changes)
        : `Undo #${undoes}: ${summarize(before, after, changes)}`;
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
      return this.insertRevision(actor, summary, changes, undoes);
    });
    this.state = after;
    for (const change of changes) {
      if (change._tag === "shareSetting") this.stuckShares.delete(change.id);
      if (change._tag === "place")
        for (const id of this.stuckShares) if (id.startsWith(`${change.id}/`)) this.stuckShares.delete(id);
    }
    this.revisions = [
      { id, at: Date.now(), actor, summary, undoes, undoneBy: null, undoable: changes.length > 0 },
      ...this.revisions.map((revision) =>
        revision.id === undoes ? { ...revision, undoneBy: id } : revision,
      ),
    ].slice(0, RECENT_REVISIONS);
    this.broadcast();
    void this.scheduleAlarm();
    return id;
  }

  private apply(actor: Actor, edits: ReadonlyArray<Edit>) {
    return this.commit(actor, refuseResume(resolveEdits(this.state, edits)), null);
  }

  /** K-1504: "Resume", after the Worker checked a passkey login of at most ten minutes. */
  private resume(caller: Caller) {
    if (!this.authorized(caller))
      return Response.json({ error: "You have no control level on the kitshn admin (K-104)." }, { status: 403 });
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

  /** K-1502: Undo makes a new revision that reverses the old one, and runs the same rules. */
  private undo(actor: Actor, revisionId: number) {
    const [row] = this.sql<{ changes: string }>("SELECT changes FROM revisions WHERE id = ?", revisionId);
    if (!row)
      throw new RuleError(`Revision #${revisionId} does not exist, or it is older than the history keeps.`);
    const inverted = invert(JSON.parse(row.changes) as Array<Change>);
    if (inverted.length === 0)
      throw new RuleError(
        `Revision #${revisionId} records an action, not a change, so it has nothing to undo.`,
      );
    // This also refuses a second undo of the same revision: its changes are no longer current.
    const conflict = conflictOf(this.state, inverted);
    if (conflict?._tag === "app")
      throw new RuleError(`A later deploy or removal changed the app "${conflict.id}", so this undo no longer fits (K-909).`);
    if (conflict)
      throw new RuleError(`A later revision changed ${conflict._tag} "${conflict.id}". Undo that revision first.`);
    // A card that joined a stack since then takes its stack along (K-521), but never into a public circle
    // without the question of K-210, which an undo does not ask.
    const changes = withStackMates(this.state, inverted);
    const own = new Set(inverted.flatMap((change) => (change._tag === "place" ? [change.id] : [])));
    const goingPublic = shareDiff(this.state, applyChanges(this.state, changes)).find(
      (diff) => !own.has(diff.resource.id) && diff.to && !diff.from && isPublicCircle(diff.circle),
    );
    if (goingPublic)
      throw new RuleError(
        `This undo would make ${goingPublic.resource.name} public through its stack. Move the stack by hand.`,
      );
    return this.commitApps(actor, refuseResume(changes), revisionId);
  }

  /** K-909: removes a deployed app; the card panel, the palette and `DELETE /api/apps/<card>` all come here. */
  private async removeApp(caller: Caller, id: string) {
    try {
      // The card panel offers "Remove app" by the same check: a repo lists the card (K-819).
      if (!this.repoViews().some((repo) => repo.resourceIds.includes(id)))
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
    undoes: number | null,
  ): Promise<{ revision: number | null; notes: Array<string> }> {
    const apps = changes.flatMap((change) => (change._tag === "app" ? [change] : []));
    // Check first, so that a refused change tears nothing down.
    this.checked(changes);
    // K-410: a Worker address goes before its card, because the card keeps its Access application.
    for (const { before, after } of apps) {
      const teardown = before && !after ? appTeardown(before, this.env.KITSHN_ZONE) : null;
      if (teardown?.kind !== "worker") continue;
      const api = this.api();
      if (!api) throw new RuleError("kitshn has no Cloudflare API token here.");
      await this.removeWorker(api, teardown.address, teardown.script);
    }
    // The state can change while Cloudflare answers.
    const conflict = conflictOf(this.state, changes);
    if (conflict) throw new RuleError(`${conflict._tag} "${conflict.id}" changed meanwhile. Try again.`);
    // K-909: a Compose app whose compose-down has not run yet never stopped, so its undo cancels that job.
    const cancelled = new Map<string, number>();
    for (const { after } of apps) {
      if (after?.kind !== "site.compose") continue;
      const down = this.removalDown(after.id);
      const step = composeUndo(down);
      if (step === "refuse")
        throw new RuleError(`The machine is stopping ${after.name} now; undo after it finishes (K-909).`);
      if (step === "cancel" && down) cancelled.set(after.id, down.id);
    }
    const revision = this.commit(actor, changes, undoes);
    for (const jobId of cancelled.values())
      this.sql(
        "UPDATE jobs SET state = 'failed', output = 'The undo of the removal cancelled this job (K-909).' WHERE id = ?",
        jobId,
      );
    const notes: Array<string> = [];
    for (const { before, after } of apps) {
      if (after && cancelled.has(after.id))
        notes.push(`${after.name} never stopped: kitshn cancelled its compose-down.`);
      else if (after) notes.push(await this.restartApp(actor, after));
      else if (before?.kind === "site.compose") notes.push(this.stopCompose(actor, before));
    }
    if (apps.length > 0) {
      this.deliverJobs();
      this.broadcast();
    }
    return { revision, notes };
  }

  /** K-909: the newest `compose-down` of a removal (it keeps the data) for this project, or null. */
  private removalDown(project: string) {
    const [row] = this.sql<{ id: number; state: NonNullable<DownJob>["state"] }>(
      `SELECT id, state FROM jobs WHERE json_extract(command, '$.kind') = 'compose-down'
       AND json_extract(command, '$.project') = ? AND json_extract(command, '$.removeData') = 0
       ORDER BY id DESC LIMIT 1`,
      project,
    );
    return row ?? null;
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
    const when = this.onlineMachines().has(machine.id) ? "now" : `when ${machine.name} comes online`;
    return `${card.name} stops on ${machine.name} ${when}; its volumes stay on the machine.`;
  }

  /** K-909: the undo of a removal starts the app again where it can, and says why where it cannot. */
  private async restartApp(actor: Actor, card: AppCard) {
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
      const repo = await this.dispatchBuild(done?.repo_id ?? "", plan.branch);
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
      paused: this.state.paused,
      repos,
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
    const attachment = socket?.deserializeAttachment() as Attachment | undefined;
    const live = attachment?.kind === "machine" ? attachment : null;
    return {
      machine,
      online: socket !== null,
      lastSeen: this.presence.get(machine.id)?.lastSeen ?? null,
      status: live?.status ?? null,
      sample: live?.sample ?? null,
      orphanVolumes: orphanVolumes(live?.volumes ?? [], this.state),
    };
  }

  /** The newest open socket of a machine, or null. */
  private openSocket(machineId: string): WebSocket | null {
    const open = this.ctx.getWebSockets(machineId).filter((socket) => socket.readyState === WebSocket.OPEN);
    return open.at(-1) ?? null;
  }

  /** Sends one changed machine to every open map, instead of a whole snapshot. */
  private sendMachine(machine: Machine) {
    const message: ServerMessage = { type: "machine", view: this.machineView(machine) };
    for (const socket of this.ctx.getWebSockets("map")) send(socket, message);
  }

  private broadcast() {
    const repos = this.repoViews();
    for (const socket of this.ctx.getWebSockets("map")) {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (attachment.kind !== "map") continue;
      const caller = attachment.caller;
      if (!this.authorized(caller)) {
        socket.close(4003, "You lost access to the kitshn admin.");
        continue;
      }
      send(socket, { type: "snapshot", snapshot: this.snapshot(caller.actor, repos) });
    }
  }

  private async handle(caller: Caller, message: ClientMessage): Promise<Extract<ServerMessage, { type: "result" }>> {
    try {
      const { revision, notes } =
        message.type === "apply"
          ? { revision: this.apply(caller.actor, message.edits), notes: [] }
          : await this.undo(caller.actor, message.revision);
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
    if (path === "/internal/offline")
      return this.offlineInfo(new URL(request.url).searchParams.get("address") ?? "");
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
    if (path === "/api/sign-out" && request.method === "POST") return this.signOut();
    if (path === "/api/machines" && request.method === "POST")
      return this.addMachine(caller, await request.json().catch(() => null), new URL(request.url).origin);
    if (path.startsWith("/api/machines/") && request.method === "POST")
      return this.updateMachine(
        caller,
        decodeURIComponent(path.slice("/api/machines/".length)),
        await request.json().catch(() => null),
      );
    if (path.startsWith("/api/machines/") && request.method === "DELETE")
      return this.removeMachine(caller, decodeURIComponent(path.slice("/api/machines/".length)));
    if (path.startsWith("/api/apps/") && request.method === "DELETE")
      return this.removeApp(caller, decodeURIComponent(path.slice("/api/apps/".length)));
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
    if (path === "/api/apply" || path === "/api/undo") {
      if (request.method !== "POST") return new Response("Use POST.", { status: 405 });
      let message: ClientMessage;
      try {
        message = decodeClientMessage({
          ...((await request.json()) as object),
          type: path.slice(5),
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
    const attachment = socket.deserializeAttachment() as Attachment;
    if (attachment.kind === "machine") {
      this.machineMessage(
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
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (attachment?.kind !== "machine") return;
    const others = this.ctx.getWebSockets(attachment.machineId).filter((other) => other !== socket);
    if (others.length > 0) return;
    // A job that the machine had when its connection ended has no result coming.
    // A compose-down can run twice without harm, so it goes out again when the machine comes back (K-909).
    this.sql(
      `UPDATE jobs SET state = 'queued' WHERE machine_id = ? AND state = 'sent' AND json_extract(command, '$.kind') = 'compose-down'`,
      attachment.machineId,
    );
    this.sql(
      `UPDATE jobs SET state = 'failed', output = '${OFFLINE_OUTPUT}' WHERE machine_id = ? AND state = 'sent'`,
      attachment.machineId,
    );
    this.setPresence(attachment.machineId, false);
  }

  /** K-605: presence rows change only when a machine goes online or offline (K-1302). */
  private setPresence(machineId: string, online: boolean) {
    const now = Date.now();
    if (this.presence.get(machineId)?.online === online) return;
    this.presence.set(machineId, { online, lastSeen: now });
    this.sql(
      "INSERT OR REPLACE INTO presence (id, online, last_seen) VALUES (?, ?, ?)",
      machineId,
      online ? 1 : 0,
      now,
    );
    this.broadcast();
    // K-1108: a machine that goes off or comes back changes the offline routes of its live sites.
    void this.scheduleAlarm();
  }

  /** Machines with an open socket. Presence rows can be stale after a deploy; sockets are not. */
  private onlineMachines() {
    return new Set([...this.state.machines.keys()].filter((id) => this.openSocket(id) !== null));
  }

  /** After a restart, a presence row says online although its socket is gone; set it offline once. */
  private reconcilePresence() {
    for (const [id, value] of this.presence)
      if (value.online && this.openSocket(id) === null) this.setPresence(id, false);
  }

  /** K-604: a daemon connects with its machine's service token; the Worker checked the Access JWT. */
  private connectMachine(request: Request, caller: Caller) {
    if (request.headers.get("upgrade") !== "websocket")
      return new Response("Expected a WebSocket.", { status: 426 });
    const machine = [...this.state.machines.values()].find(
      (item) => item.clientId === caller.visitor.clientId,
    );
    if (!machine)
      return Response.json({ error: "This service token belongs to no joined machine." }, { status: 403 });
    for (const old of this.ctx.getWebSockets(machine.id))
      old.close(4001, "A newer connection of this machine replaced it.");
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [machine.id, "machines"]);
    server.serializeAttachment({
      kind: "machine",
      machineId: machine.id,
      since: Date.now(),
      status: null,
      sample: null,
    } satisfies Attachment);
    if (this.presence.get(machine.id)?.online) this.sendMachine(machine);
    else this.setPresence(machine.id, true);
    this.deliverJobs();
    void this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  private machineMessage(
    socket: WebSocket,
    attachment: Extract<Attachment, { kind: "machine" }>,
    text: string,
  ) {
    const machine = this.state.machines.get(attachment.machineId);
    if (!machine) return;
    let message: DaemonMessage;
    try {
      message = JSON.parse(text) as DaemonMessage;
    } catch {
      return;
    }
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
      };
      socket.serializeAttachment({ ...attachment, status } satisfies Attachment);
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
    } else if (message.type === "volumes" && Array.isArray(message.volumes)) {
      const volumes = message.volumes
        .filter((item) => isRecord(item) && typeof item["name"] === "string" && typeof item["project"] === "string")
        .slice(0, 200)
        .map((item): ProjectVolume => ({ name: item.name.slice(0, 255), project: item.project.slice(0, 63) }));
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
        ? this.sql<{ command: string; actor: string }>("SELECT command, actor FROM jobs WHERE id = ?", message.id)
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
      if (command?.kind === "compose")
        this.sql(
          "UPDATE deploys SET state = ? WHERE job_id = ? AND state = 'running'",
          result.ok === true ? "done" : "failed",
          message.id,
        );
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

  /** K-602: trades a join code, once and within 10 minutes, for the sealed machine secrets. */
  private async exchangeJoin(request: Request) {
    const body = (await request.json().catch(() => null)) as { code?: unknown } | null;
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!code) return Response.json({ error: "Send the join code." }, { status: 400 });
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
    this.sql("DELETE FROM join_codes WHERE lookup = ?", lookup);
    if (row.expires_at < Date.now()) {
      return Response.json(
        { error: "This join code expired. Make a new one with Add machine." },
        { status: 410 },
      );
    }
    return Response.json({ iv: row.iv, sealed: row.sealed });
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
      this.forgetCard(id);
      this.sql("DELETE FROM jobs WHERE machine_id = ? AND state IN ('queued', 'sent')", id);
      this.sql("DELETE FROM join_codes WHERE machine_id = ?", id);
      this.sql("DELETE FROM tunnel_objects WHERE machine_id = ?", id);
      for (const site of this.sitesOf(id)) {
        this.sql("DELETE FROM live_sites WHERE id = ?", site.id);
        this.forgetCard(site.id);
      }
      this.insertRevision(caller.actor, `Removed machine ${machine.name}`, [], null);
    });
    this.presence.delete(id);
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
        ? (target ? this.machineView(target).orphanVolumes : []).find((volume) => volume.name === parsed.volume)
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
    const online = this.onlineMachines();
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

  /** K-1107: closes machine sockets that answered no ping for 30 seconds. */
  private checkLiveness(now: number) {
    for (const socket of this.ctx.getWebSockets("machines")) {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (attachment.kind !== "machine") continue;
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
          console.warn(`kitshn writes the ingress of ${site.address} without the Access check: ${access.reason}.`);
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

  /** Deletes a card's rows and takes it out of its stack, inside the caller's transaction (K-522). */
  private forgetCard(id: string) {
    for (const table of ["resources", "places"]) this.sql(`DELETE FROM ${table} WHERE id = ?`, id);
    this.sql("DELETE FROM share_settings WHERE id LIKE ?", `${id}/%`);
    const stacks = this.sql<{ id: string; body: string }>("SELECT id, body FROM stacks").map(
      (row) => JSON.parse(row.body) as Stack,
    );
    for (const change of stacksWithout(stacks, id)) {
      if (change.after) this.sql("UPDATE stacks SET body = ? WHERE id = ?", JSON.stringify(change.after), change.id);
      else this.sql("DELETE FROM stacks WHERE id = ?", change.id);
    }
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
    return [...this.liveSites.values()].filter((site) => {
      if (site.state !== "ok" || (machineId !== undefined && site.machineId !== machineId)) return false;
      // The application exists in Cloudflare; a later failed update of it does not take the site down.
      return Boolean(this.access.get(`app:${site.id}:${site.address}`)?.cfId);
    });
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
        this.forgetCard(site.id);
        if (site.state === "ok" && hadCard) {
          this.insertRevision(
            { _tag: "kitshn", reason: `live site on ${machine.name}` },
            `${machine.name} stopped exposing ${site.address}`,
            [],
            null,
          );
        }
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
        return machine ? [[site.address, `${machine.tunnelId}.cfargotunnel.com`] as const] : [];
      }),
    );
    const routed = reachableAddresses({
      ingress: this.tunnelRows().map((row) => row.applied),
      records: [],
      routes: this.sql<{ address: string; route_id: string }>("SELECT address, route_id FROM route_objects"),
    });
    return [
      ...[...wanted]
        .filter(([address, content]) => {
          const row = rows.get(address);
          return due(address) && (!row || row.error !== null || row.content !== content);
        })
        .map(([address, content]) => ({ address, content: content as string | null })),
      ...[...rows.values()]
        .filter((row) => !wanted.has(row.address) && due(row.address) && !routed.has(row.address))
        .map((row) => ({ address: row.address, content: null })),
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

  /** K-1104: a proxied CNAME per live site to its machine's tunnel. kitshn deletes only records it made. */
  private async syncDns(api: Api, budget: number) {
    let calls = 0;
    const zone = `/zones/${this.env.CLOUDFLARE_ZONE_ID}/dns_records`;
    for (const work of this.dnsWork()) {
      if (calls >= budget) return;
      calls++;
      const [row] = this.sql<{ record_id: string }>(
        "SELECT record_id FROM dns_objects WHERE address = ?",
        work.address,
      );
      try {
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
            "INSERT OR REPLACE INTO dns_objects (address, record_id, content, error, retry_at) VALUES (?, ?, ?, NULL, 0)",
            work.address,
            record.id,
            work.content,
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
          "INSERT OR REPLACE INTO dns_objects (address, record_id, content, error, retry_at) VALUES (?, ?, ?, ?, ?)",
          work.address,
          row?.record_id ?? "",
          work.content ?? "",
          String(error),
          Date.now() + RETRY_MS,
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
    const routes = `/zones/${this.env.CLOUDFLARE_ZONE_ID}/workers/routes`;
    for (const work of this.routeWork()) {
      if (calls++ >= budget) return;
      try {
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
    const site = [...this.liveSites.values()].find((item) => item.address === address);
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

  /** K-1302: one alarm for the next due item. Access work, share end dates, and the daily run. */
  private async scheduleAlarm() {
    const now = Date.now();
    let next = this.dailyAt();
    if (this.ctx.getWebSockets("machines").length > 0) next = Math.min(next, now + PING_TIMEOUT_MS);
    if (this.env.CLOUDFLARE_API_TOKEN && this.tunnelWork()) next = now;
    const [job] = this.sql<{ expires_at: number }>(
      "SELECT MIN(expires_at) AS expires_at FROM jobs WHERE state IN ('queued', 'sent')",
    );
    if (job?.expires_at) next = Math.min(next, Math.max(job.expires_at, now));
    const desired = this.desired(now);
    if (
      this.env.CLOUDFLARE_API_TOKEN &&
      (hasAccessWork(desired, this.access, this.reachableAddresses(), loginHeld(this.meta("login_held") ?? "")) || this.launcherWork() || this.loginWork())
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
            ...stacksWithout(this.state.stacks.values(), resourceId).map(
              (change): Edit => ({ _tag: "stack", ...change }),
            ),
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
      this.sql(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('daily_at', ?)",
        String(nextUtcMidnight(now)),
      );
    });
    for (const row of this.access.values()) if (row.error) this.access.set(row.key, { ...row, error: null });
    this.load();
  }

  /** K-110: ends every session of every application that kitshn made. */
  private async signOut() {
    // K-110: the Worker checks pages and files itself, so it refuses every login from before this second.
    this.setMeta("signed_out_at", String(Math.floor(Date.now() / 1000) * 1000));
    const api = this.api();
    if (!api) return Response.json({ error: "kitshn has no Cloudflare API token here." }, { status: 503 });
    try {
      const account = this.env.CLOUDFLARE_ACCOUNT_ID;
      const logins = new Set(
        ["pages", "files"].flatMap((host) => [
          `${host}.${this.env.KITSHN_ZONE}/login`,
          `${host}.${this.env.KITSHN_ZONE}/login/passkey`,
        ]),
      );
      const all = await api<Array<{ id: string; name: string; domain: string }>>(
        "GET",
        `/accounts/${account}/access/apps?per_page=1000`,
      );
      const loginApps = all
        .filter((app) => logins.has(app.domain) && app.name.startsWith(ACCESS_NAME_PREFIX))
        .map((app) => ({ key: app.domain, cfId: app.id }));
      return Response.json(await signOutEverywhere(this.accessStore(), api, account, loginApps));
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 502 });
    }
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
      },
      Date.now(),
      gate !== undefined && this.keyRemoved(gate),
    );
    const record = decision.record;
    if (record) {
      this.ctx.storage.transactionSync(() => {
        this.sql(
          `INSERT OR REPLACE INTO repos (repo_id, name, state, first_seen, branch, allowed_by_client, allowed_by_name)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          record.repoId,
          record.name,
          record.state,
          record.firstSeen,
          record.branch,
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

  /** K-819: each repo with its cards on the map, for the card panel. */
  private repoViews(): Array<RepoView> {
    const cards = new Map<string, Array<string>>();
    for (const { repo_id, resource_id } of this.sql<{ repo_id: string; resource_id: string }>(
      "SELECT repo_id, resource_id FROM deploys WHERE repo_id IS NOT NULL AND kind = 'deploy' GROUP BY repo_id, resource_id",
    ))
      if (this.state.resources.has(resource_id))
        cards.set(repo_id, [...(cards.get(repo_id) ?? []), resource_id]);
    return this.sql<RepoRow>("SELECT * FROM repos ORDER BY first_seen DESC").map((row) => {
      const gate = repoGateOf(row);
      const removed = this.keyRemoved(gate);
      // K-819: the repo of a removed key shows as waiting, so the owner sees it and takes it over.
      return { ...gate, state: removed ? "waiting" : gate.state, keyRemoved: removed, resourceIds: cards.get(row.repo_id) ?? [] };
    });
  }

  /** K-819: the agent key that allowed this repo has no agent circle anymore (keyRemoved). */
  private keyRemoved(gate: RepoGate) {
    return keyRemoved(gate, (clientId) => circlesOf(this.state, { email: null, clientId, ip: null }, Date.now()).size > 0);
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
  private async setRepoState(caller: Caller, repoId: string, body: unknown, allowedBy: AllowingAgent | null = null) {
    const state = isRecord(body) ? body["state"] : null;
    if (state !== "allowed" && state !== "blocked" && state !== "forget")
      return Response.json({ error: 'Send {"state": "allowed" | "blocked" | "forget"}.' }, { status: 400 });
    const [row] = this.sql<RepoRow>("SELECT * FROM repos WHERE repo_id = ?", repoId);
    if (!row) return Response.json({ error: `kitshn knows no repo ${repoId}.` }, { status: 404 });
    if (state === "forget" && row.state !== "waiting")
      return Response.json(
        { error: "Only a waiting repo can be forgotten; block the others." },
        { status: 409 },
      );
    const stopped = this.ctx.storage.transactionSync(() => {
      if (state === "forget") {
        this.sql("DELETE FROM repos WHERE repo_id = ?", repoId);
        this.insertRevision(caller.actor, `Forgot ${row.name} (K-819)`, [], null);
        return [];
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
          "UPDATE repos SET state = 'blocked', branch = NULL, allowed_by_client = NULL, allowed_by_name = NULL WHERE repo_id = ?",
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
      // A teardown still runs (K-819); a daemon that already has the source can still finish its build.
      this.sql(
        `UPDATE jobs SET state = 'failed', output = ? WHERE state IN ('queued', 'sent')
         AND json_extract(command, '$.kind') != 'compose-down'
         AND json_extract(command, '$.project') IN (SELECT resource_id FROM deploys WHERE repo_id = ?)`,
        `The owner blocked deploys of ${row.name} (K-819).`,
        repoId,
      );
      return this.sql<{ id: string; app: string }>(
        `UPDATE deploys SET state = 'failed' WHERE repo_id = ? AND kind = 'deploy' AND state IN ('planned', 'running')
         RETURNING id, app`,
        repoId,
      );
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
    const started = await this.agentBuild(caller, repoId, branch);
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
      if (!row || row.repo_id !== deployer.repoId) return fail(404, "kitshn knows no such deploy of this repo.");
      if (row.expires_at < Date.now() || row.state !== "planned")
        return fail(410, "This deploy expired or ended. Run it again.");
      // A blocked repo still tears down what it made (K-819).
      const gate = row.kind === "teardown" ? null : this.repoGate(deployer);
      if (gate) return gate;
      if (path === "/deploy/assets" && row.kind === "deploy")
        return await this.deployAssets(api, row, input["manifest"]);
      if (path === "/deploy/finish" && row.kind === "deploy")
        return await this.finishDeploy(api, row, deployer, input["jwt"]);
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
    const result = plan(recipe, deployer.repo, event, this.env.KITSHN_ZONE);
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
    const { resourceId, script } = environmentNames(deployer.repoId, deployer.repo, result.environment);
    const existing = this.state.resources.get(resourceId);
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
        if (result.kind === "deploy" && !mayDeployOn(this.state, allowedBy?.clientId ?? null, existing.machine, Date.now()))
          return Response.json({ error: `${existing.name} runs on a machine that it may no longer use.${agentLimit}` }, { status: 409 });
        machineId = existing.machine;
        const running = this.state.machines.get(existing.machine);
        if (result.kind === "deploy" && running && !this.machineView(running).status?.capabilities?.includes("compose-guard"))
          return Response.json(
            { error: `Update the daemon on ${running.name} first: it does not check Compose settings yet (K-818).` },
            { status: 409 },
          );
      } else if (result.kind === "deploy") {
        const labels = compose.runsOn ?? [];
        const pick = [...this.state.machines.values()]
          // Only a machine that the owner labels "deploy" runs the apps of repos (K-610).
          .filter((machine) => ["deploy", ...labels].every((label) => machine.labels.includes(label)))
          // K-818: only a daemon that checks Compose settings runs the apps of repos.
          .filter((machine) => this.machineView(machine).status?.capabilities?.includes("compose-guard"))
          .filter((machine) => mayDeployOn(this.state, allowedBy?.clientId ?? null, machine.id, Date.now()))
          .sort((a, b) => a.order - b.order)
          .find((machine) => this.presence.get(machine.id)?.online);
        if (!pick) {
          return Response.json(
            {
              error: `No online machine with a Compose-ready daemon has the labels ${["deploy", ...labels].join(", ")}. Label a machine "deploy", update its daemon, or start it.${agentLimit}`,
            },
            { status: 409 },
          );
        }
        machineId = pick.id;
      }
    }
    if (existing && !existing.addresses.includes(result.address)) {
      return Response.json(
        {
          error: `${result.environment} lives at ${existing.addresses[0]}. To move it, remove its card on the map first.`,
        },
        { status: 409 },
      );
    }
    const other = [...this.state.resources.values()].find(
      (resource) => resource.id !== resourceId && resource.addresses.includes(result.address),
    );
    if (other)
      return Response.json(
        { error: `${result.address} belongs to the card ${other.name}.` },
        { status: 409 },
      );
    if (result.kind === "deploy") {
      // Never take over a hostname that another Worker serves, or that a foreign Access app covers (K-408).
      const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
      const domains = await api<Array<{ service: string }>>(
        "GET",
        `${account}/workers/domains?hostname=${encodeURIComponent(result.address)}`,
      );
      const foreign = domains.find((domain) => domain.service !== script);
      if (foreign) {
        return Response.json(
          { error: `${result.address} already serves the Worker ${foreign.service}.` },
          { status: 409 },
        );
      }
      const apps = await api<Array<{ name: string; domain?: string }>>(
        "GET",
        `${account}/access/apps?per_page=1000`,
      );
      const foreignApp = apps.find((app) => app.domain === result.address && !app.name.startsWith("kitshn "));
      if (foreignApp) {
        return Response.json(
          {
            error: `The Access application "${foreignApp.name}" covers ${result.address}; kitshn does not change it.`,
          },
          { status: 409 },
        );
      }
    }
    if (result.kind === "deploy" && !existing) {
      // Only an address that nothing uses yet: kitshn never takes over a record that it did not make.
      const records = await api<Array<unknown>>(
        "GET",
        `/zones/${this.env.CLOUDFLARE_ZONE_ID}/dns_records?name=${encodeURIComponent(result.address)}`,
      );
      if (records.length > 0)
        return Response.json({ error: `${result.address} already has a DNS record.` }, { status: 409 });
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
      `INSERT INTO deploys (id, repo, repo_id, environment, resource_id, address, script, starts_in, kind, sha, state, expires_at, branch, app, machine_id, compose_file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?)`,
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
      compose ? "compose" : "static",
      machineId,
      compose?.file ?? null,
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
    kind: "site.static" | "site.compose",
    machine: string | null,
  ) {
    const actor: Actor = { _tag: "kitshn", reason: `deploy of ${row.repo} ${deployer.sha.slice(0, 7)}` };
    if (this.state.resources.has(row.resource_id))
      return "The card keeps its place; the map decides who opens it (K-807).";
    const slug = repoSlug(row.repo);
    this.putResource({
      id: row.resource_id,
      kind,
      name: row.environment === "prod" ? slug : `${slug} ${row.environment}`,
      addresses: [row.address],
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
        { error: `The agent key ${allowedBy?.name} that allowed this repo no longer manages ${machine.name} (K-819).` },
        { status: 409 },
      );
    const card = this.ensureCard(row, deployer, "site.compose", machine.id);
    // Fail closed: the Access application exists before the tunnel sends the address to the app (K-410).
    await this.syncAccessLocked(api, 20);
    const app = this.access.get(`app:${row.resource_id}:${row.address}`);
    if (!app?.cfId || app.error)
      return Response.json(
        {
          error: `The Access application of ${row.address} is not ready: ${app?.error ?? "pending"}. Run the deploy again.`,
        },
        { status: 503 },
      );
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
        this.forgetCard(row.resource_id);
    });
    this.load();
    this.deliverJobs();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ removed: row.address });
  }

  private async finishDeploy(api: Api, row: DeployRow, deployer: Deployer, jwt: unknown) {
    if (typeof jwt !== "string" || !jwt)
      return Response.json({ error: "The deploy needs the upload completion token." }, { status: 400 });
    const card = this.ensureCard(row, deployer, "site.static", null);
    // Fail closed: the Access application exists before the address does.
    await this.syncAccessLocked(api, 20);
    const app = this.access.get(`app:${row.resource_id}:${row.address}`);
    if (!app?.cfId || app.error) {
      return Response.json(
        {
          error: `The Access application of ${row.address} is not ready: ${app?.error ?? "pending"}. Run the deploy again.`,
        },
        { status: 503 },
      );
    }
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    const metadata = {
      main_module: "worker.js",
      compatibility_date: "2026-10-20",
      assets: { jwt, config: { not_found_handling: "404-page", html_handling: "auto-trailing-slash" } },
      bindings: [{ type: "assets", name: "ASSETS" }],
    };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append(
      "worker.js",
      new Blob([STATIC_WORKER], { type: "application/javascript+module" }),
      "worker.js",
    );
    const scripts = await api<Array<{ id: string }>>("GET", `${account}/workers/scripts`);
    const isNew = !scripts.some((item) => item.id === row.script);
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
    const domains = await api<Array<{ id: string; service: string }>>(
      "GET",
      `${account}/workers/domains?hostname=${encodeURIComponent(row.address)}`,
    );
    const attached = domains.find((domain) => domain.service === row.script);
    const endedBeforeAddress = this.endedRefusal(row.id);
    if (endedBeforeAddress) return endedBeforeAddress;
    if (!attached) {
      if (domains.length > 0) throw new Error(`${row.address} already serves another Worker.`);
      await api("PUT", `${account}/workers/domains`, {
        hostname: row.address,
        service: row.script,
        zone_id: this.env.CLOUDFLARE_ZONE_ID,
        environment: "production",
      });
    }
    // K-814: the route check records what a visitor without a login gets.
    const check = await fetch(`https://${row.address}/`, { redirect: "manual" }).catch(() => null);
    const resource = this.state.resources.get(row.resource_id);
    if (resource) this.putResource({ ...resource, status: "running" });
    this.sql("UPDATE deploys SET state = 'done' WHERE id = ? AND state = 'planned'", row.id);
    this.load();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ address: row.address, status: check?.status ?? 0, card });
  }

  /** K-904: a closed pull request removes its preview: the address, the Worker, the card and its Access app. */
  private async teardown(api: Api, row: DeployRow, deployer: Deployer) {
    await this.removeWorker(api, row.address, row.script);
    const resource = this.state.resources.get(row.resource_id);
    this.ctx.storage.transactionSync(() => {
      this.forgetCard(row.resource_id);
      this.sql("UPDATE deploys SET state = 'done' WHERE id = ?", row.id);
      if (resource)
        this.insertRevision(
          { _tag: "kitshn", reason: `pull request closed in ${row.repo}, ${deployer.sha.slice(0, 7)}` },
          `Removed ${resource?.name ?? row.environment}, its preview closed (K-904)`,
          [],
          null,
        );
    });
    this.load();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ removed: row.address });
  }

  /** K-904, K-909: takes a Worker site's address off, confirms it, then deletes the Worker script. */
  private async removeWorker(api: Api, address: string, script: string) {
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    const domains = await api<Array<{ id: string; service: string }>>(
      "GET",
      `${account}/workers/domains?hostname=${encodeURIComponent(address)}`,
    );
    for (const domain of domains.filter((item) => item.service === script)) {
      await api("DELETE", `${account}/workers/domains/${domain.id}`);
    }
    // K-006: the card, and with it the Access application, goes only after the address is confirmed gone.
    const left = await api<Array<{ service: string }>>(
      "GET",
      `${account}/workers/domains?hostname=${encodeURIComponent(address)}`,
    );
    if (left.some((item) => item.service === script)) {
      throw new Error(`${address} still serves ${script}; run the teardown again.`);
    }
    await api("DELETE", `${account}/workers/scripts/${script}?force=true`).catch((error: unknown) =>
      error instanceof CloudflareError && error.status === 404 ? undefined : Promise.reject(error),
    );
  }

  /** A job that kitshn makes itself, so it needs no member with control (K-614). Returns the job id. */
  private queueKitshnJob(machineId: string, command: Command, actor: Actor, expiresAt: number) {
    const now = Date.now();
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
      return own.has(id) || (rights.includes("publishes") && circle !== undefined && isEveryoneCircle(circle));
    };
    // K-718: the cards of repos that this key allowed (K-819); only these may become public.
    const added = new Set(
      this.sql<{ resource_id: string }>(
        `SELECT DISTINCT deploys.resource_id FROM deploys JOIN repos ON repos.repo_id = deploys.repo_id
         WHERE repos.allowed_by_client = ?`,
        caller.visitor.clientId,
      ).map((row) => row.resource_id),
    );
    const move = (edits: ReadonlyArray<Edit>) => {
      try {
        const changes = resolveEdits(this.state, edits);
        const refusal = agentRefusal(this.state, applyChanges(this.state, changes), caller.visitor, changes, now, added);
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
          ? this.sql<RepoRow>("SELECT * FROM repos WHERE state = 'waiting' ORDER BY first_seen DESC").map((row) => ({
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
        return Response.json({ error: "An agent key does not delete volumes (K-718, K-909)." }, { status: 403 });
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
      if (!job)
        return Response.json({ error: `This key sent no job ${id}.` }, { status: 404 });
      return Response.json(job);
    }
    if (path.startsWith("/agent/repos/") && request.method === "POST") {
      // K-1504: the pause stops agent keys.
      if (this.state.paused)
        return Response.json({ error: "kitshn is paused (Emergency pause). Agent keys wait until Resume." }, { status: 423 });
      const repoId = decodeURIComponent(path.slice("/agent/repos/".length));
      const body: unknown = await request.json().catch(() => null);
      const [row] = this.sql<RepoRow>("SELECT * FROM repos WHERE repo_id = ?", repoId);
      const refusal = agentAllowRefusal(
        row ? repoGateOf(row) : undefined,
        isRecord(body) ? body["state"] : null,
        agentHas(this.state, caller.visitor, "addsApps", Date.now()),
      );
      if (refusal) return Response.json({ error: refusal.error }, { status: refusal.status });
      // An agent circle names this key, so its device member exists.
      if (device?._tag !== "device") throw new Error("An agent key without its device member allowed a repo.");
      return this.setRepoState(agent, repoId, { state: "allowed" }, { clientId: device.clientId, name: device.name });
    }
    if (path === "/agent/deploy" && request.method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      const card = isRecord(body) && typeof body["card"] === "string" ? body["card"] : null;
      const mode = isRecord(body) ? body["mode"] : null;
      if (card === null || (mode !== "redeploy" && mode !== "build"))
        return Response.json({ error: 'Send {"card": <id>, "mode": "redeploy" | "build"}.' }, { status: 400 });
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
      if (plan.kind === "build") return this.agentBuild(agent, repoId, plan.branch);
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
    return machine.labels.includes("deploy") ? null : "The machine of this app no longer has the label deploy (K-610).";
  }

  /** K-718: queues the start of the last build that came up; kitshn makes the job, the key reads it. */
  private agentRedeploy(caller: Caller, machineId: string, command: Extract<Command, { kind: "compose-redeploy" }>) {
    const now = Date.now();
    const id = this.ctx.storage.transactionSync(() => {
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
  private async agentBuild(caller: Caller, repoId: string, branch: string) {
    if (!this.env.GITHUB_APP_ID || !this.env.GITHUB_APP_KEY)
      return Response.json({ error: NO_GITHUB_APP }, { status: 503 });
    let repo: string;
    try {
      repo = await this.dispatchBuild(repoId, branch);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
    }
    this.ctx.storage.transactionSync(() =>
      this.insertRevision(caller.actor, `Started a deploy of ${repo} from ${branch}`, [], null),
    );
    this.load();
    this.broadcast();
    return Response.json({ dispatched: { repo, branch, workflow: AGENT_WORKFLOW } });
  }

  /** K-718, K-908, K-909: runs the kitshn workflow of a repo on one branch. Returns the repo's current name. */
  private async dispatchBuild(repoId: string, branch: string) {
    const appId = this.env.GITHUB_APP_ID;
    const key = this.env.GITHUB_APP_KEY;
    if (!appId || !key) throw new Error(NO_GITHUB_APP);
    const repo = await dispatchDeploy({ id: appId, key }, repoId, branch, AGENT_WORKFLOW);
    this.sql("UPDATE repos SET name = ? WHERE repo_id = ?", repo, repoId);
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
    // The stream fails when the body is not exactly Content-Length bytes, so the limit holds.
    const { readable, writable } = new FixedLengthStream(size);
    const piped = request.body.pipeTo(writable);
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
    const revision = this.ctx.storage.transactionSync(() => {
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
      this.forgetCard(id);
      this.insertRevision(caller.actor, `Deleted the ${item.kind} ${item.title}`, [], null);
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
      return await this.withAccessLock(() => fillAudiences(this.accessStore(), api, this.env.CLOUDFLARE_ACCOUNT_ID));
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

      changed ||=
        daily || JSON.stringify(accessStates(this.desired(now), this.access)) !== before;
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
  allowed_by_client: string | null;
  allowed_by_name: string | null;
}

const repoGateOf = (row: RepoRow): RepoGate => ({
  repoId: row.repo_id,
  name: row.name,
  state: row.state,
  firstSeen: row.first_seen,
  branch: row.branch,
  allowedBy:
    row.allowed_by_client === null ? null : { clientId: row.allowed_by_client, name: row.allowed_by_name ?? "" },
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
  app: "static" | "compose";
  machine_id: string | null;
  job_id: number | null;
  compose_file: string | null;
  /** The branch that the deploy came from (K-807). */
  branch: string;
}

/** A failed tunnel, DNS or route write tries again after this time. */
const RETRY_MS = 5 * 60_000;

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
function parsePausedBy(actor: string | null, at: string | null): { readonly actor: Actor; readonly at: number } | null {
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
