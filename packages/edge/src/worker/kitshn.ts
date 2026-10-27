import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";
import { ACCESS_NAME_PREFIX, ENROLLMENT_KEY, desiredAccess } from "../core/access.ts";
import {
  type Actor,
  type Change,
  type Edit,
  RuleError,
  applyChanges,
  conflictOf,
  deepEqual,
  invert,
  resolveEdits,
  ruleViolation,
  summarize,
} from "../core/changes.ts";
import {
  ADMIN_RESOURCE_ID,
  type Circle,
  type Member,
  type Point,
  type Resource,
  type ShareSetting,
  type State,
  circlesHolding,
} from "../core/model.ts";
import {
  type Command,
  type DaemonMessage,
  type Machine,
  type MachineStatus,
  type Sample,
  type ServerToDaemon,
  joinLookup,
  newJoinCode,
  sealJoin,
} from "../core/machine.ts";
import { placeInside } from "../core/place.ts";
import type { MachineView, RevisionView, ServerMessage, Snapshot } from "../core/protocol.ts";
import { ClientMessage } from "../core/schema.ts";
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
  hasAccessWork,
  signOutEverywhere,
  syncAccess,
  syncLauncher,
  verifyAccess,
  verifyPasskeys,
} from "./access-sync.ts";
import type { Caller, Deployer } from "./auth.ts";
import { CloudflareError, cloudflare } from "./cloudflare.ts";
import { migrate } from "./migrations.ts";
import {
  DEPLOY_MS,
  SCRIPT_LIMIT,
  STATIC_WORKER,
  environmentNames,
  eventOf,
  parseManifest,
} from "./deploys.ts";
import { type Recipe, decodeRecipe, plan, repoSlug } from "kitshn/recipe";
import {
  type LiveSite,
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
      ctx.storage.transactionSync(() =>
        migrate((query) => ctx.storage.sql.exec(query), Number(version?.value ?? 0)),
      );
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
      paused: this.meta("paused") === "true",
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
      this.sql<{ key: string; cf_id: string; body: string; tried: string; error: string | null }>(
        "SELECT key, cf_id, body, tried, error FROM access_objects",
      ).map((row) => [
        row.key,
        { key: row.key, cfId: row.cf_id, body: row.body, tried: row.tried, error: row.error },
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
        this.setMeta("paused", String(change.after));
        continue;
      }
      const table =
        change._tag === "circle" ? "circles" : change._tag === "place" ? "places" : "share_settings";
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

  /** One write: checks the rules (K-105), stores the changes and one revision (K-1501), then tells everyone. */
  private commit(actor: Actor, changes: ReadonlyArray<Change>, undoes: number | null): number | null {
    if (changes.length === 0) return null;
    const before = this.state;
    const after = applyChanges(before, changes);
    const violation = ruleViolation(after);
    if (violation) throw new RuleError(violation);
    const summary =
      undoes === null
        ? summarize(before, after, changes)
        : `Undo #${undoes}: ${summarize(before, after, changes)}`;
    const id = this.ctx.storage.transactionSync(() => {
      this.persist(changes);
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
    return this.commit(actor, resolveEdits(this.state, edits), null);
  }

  /** K-1502: Undo makes a new revision that reverses the old one, and runs the same rules. */
  private undo(actor: Actor, revisionId: number) {
    const [row] = this.sql<{ changes: string }>("SELECT changes FROM revisions WHERE id = ?", revisionId);
    if (!row)
      throw new RuleError(`Revision #${revisionId} does not exist, or it is older than the history keeps.`);
    const changes = invert(JSON.parse(row.changes) as Array<Change>);
    if (changes.length === 0)
      throw new RuleError(
        `Revision #${revisionId} records an action, not a change, so it has nothing to undo.`,
      );
    // This also refuses a second undo of the same revision: its changes are no longer current.
    const conflict = conflictOf(this.state, changes);
    if (conflict) throw new RuleError(`A later revision changed ${conflict}. Undo that revision first.`);
    return this.commit(actor, changes, revisionId);
  }

  private authorized(caller: Caller) {
    const admin = this.state.resources.get(ADMIN_RESOURCE_ID);
    return admin !== undefined && visitorLevel(this.state, admin, caller.visitor, Date.now()) === "control";
  }

  private snapshot(me: Actor): Snapshot {
    return {
      circles: [...this.state.circles.values()],
      resources: [...this.state.resources.values()],
      places: Object.fromEntries(this.state.places) as Record<string, Point>,
      shareSettings: Object.fromEntries(this.state.shareSettings) as Record<string, ShareSetting>,
      revisions: this.revisions,
      access: accessStates(desiredAccess(this.state, Date.now()), this.access),
      accessWarnings: this.accessWarnings,
      paused: this.state.paused,
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
    for (const socket of this.ctx.getWebSockets("map")) {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (attachment.kind !== "map") continue;
      const caller = attachment.caller;
      if (!this.authorized(caller)) {
        socket.close(4003, "You lost access to the kitshn admin.");
        continue;
      }
      send(socket, { type: "snapshot", snapshot: this.snapshot(caller.actor) });
    }
  }

  private handle(caller: Caller, message: ClientMessage): Extract<ServerMessage, { type: "result" }> {
    try {
      const revision =
        message.type === "apply"
          ? this.apply(caller.actor, message.edits)
          : this.undo(caller.actor, message.revision);
      return { type: "result", requestId: message.requestId, ok: true, revision };
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
      const result = this.handle(caller, message);
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
      send(socket, this.handle(caller, message));
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
        ? this.sql<{ command: string }>("SELECT command FROM jobs WHERE id = ?", message.id)
        : [];
      const command = job ? (JSON.parse(job.command) as Command) : null;
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
      for (const table of ["machines", "resources", "places", "presence"])
        this.sql(`DELETE FROM ${table} WHERE id = ?`, id);
      this.sql("DELETE FROM jobs WHERE machine_id = ? AND state IN ('queued', 'sent')", id);
      this.sql("DELETE FROM join_codes WHERE machine_id = ?", id);
      this.sql("DELETE FROM tunnel_objects WHERE machine_id = ?", id);
      for (const site of this.sitesOf(id)) {
        for (const table of ["live_sites", "resources", "places"])
          this.sql(`DELETE FROM ${table} WHERE id = ?`, site.id);
        this.sql("DELETE FROM share_settings WHERE id LIKE ?", `${site.id}/%`);
      }
      this.sql("DELETE FROM share_settings WHERE id LIKE ?", `${id}/%`);
      this.insertRevision(caller.actor, `Removed machine ${machine.name}`, [], null);
    });
    this.presence.delete(id);
    this.load();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ removed: id });
  }

  /** K-614: the sender of a command needs control on the machine card itself, not only on the admin. */
  private canControl(visitor: Visitor, machineId: string) {
    const resource = this.state.resources.get(machineId);
    return resource !== undefined && visitorLevel(this.state, resource, visitor, Date.now()) === "control";
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
    const command: Command =
      parsed.kind === "update" ? { kind: "update", version: this.env.KITSHN_VERSION } : parsed;
    const labels = parseLabels(input["labels"] ?? []);
    if (typeof labels === "string") return Response.json({ error: labels }, { status: 400 });
    const machineId = typeof input["machineId"] === "string" ? input["machineId"] : null;
    const target = machineId === null ? null : this.state.machines.get(machineId);
    if (machineId !== null && !target) {
      return Response.json({ error: `No machine "${machineId}" exists.` }, { status: 404 });
    }
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
      // A job that kitshn makes itself (a deploy) needs no member with control (K-614).
      const allowed = new Set(
        visitor.kitshn ? online : [...online].filter((id) => this.canControl(visitor, id)),
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
        if (!status.capabilities?.includes("update")) {
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
    const updated: Machine = { ...machine, labels: [...labels], order };
    if (deepEqual(updated, machine)) return Response.json(updated);
    this.ctx.storage.transactionSync(() => {
      this.sql("UPDATE machines SET body = ? WHERE id = ?", JSON.stringify(updated), id);
      this.insertRevision(
        caller.actor,
        `Changed machine ${machine.name}: labels ${labels.join(", ") || "none"}, order ${order}`,
        [],
        null,
      );
    });
    this.load();
    this.deliverJobs();
    this.broadcast();
    return Response.json(updated);
  }

  private recentJobs(limit: number, outputLimit = 4000): Array<Job> {
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
      "SELECT id, machine_id, labels, command, state, created_at, expires_at, actor, exit_code, output FROM jobs ORDER BY id DESC LIMIT ?",
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
    for (const machine of this.state.machines.values()) {
      const config = tunnelConfig(this.protectedSites(machine.id));
      const body = JSON.stringify(config);
      const row = rows.get(machine.id);
      if (row?.applied === body && row.error === null) continue;
      if (row?.error && row.retry_at > now) continue;
      if (calls++ >= budget) return;
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
    const stale = [...this.state.machines.values()].some((machine) => {
      const row = tunnels.get(machine.id);
      const due = !row?.error || row.retry_at <= now;
      return due && row?.applied !== JSON.stringify(tunnelConfig(this.protectedSites(machine.id)));
    });
    const checking = [...this.liveSites.values()].some(
      (site) => site.state === "checking" && (this.checkRetryAt.get(site.id) ?? 0) <= Date.now(),
    );
    return stale || checking || this.dnsWork().length > 0 || this.routeWork().length > 0;
  }

  private sitesOf(machineId: string) {
    return [...this.liveSites.values()].filter((site) => site.machineId === machineId);
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
        const id = app?.id ?? liveSiteId(machine.id, report.name);
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
        for (const table of ["live_sites", "resources", "places"])
          this.sql(`DELETE FROM ${table} WHERE id = ?`, site.id);
        this.sql("DELETE FROM share_settings WHERE id LIKE ?", `${site.id}/%`);
        if (site.state === "ok") {
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
    const desired = desiredAccess(this.state, now);
    if (
      this.env.CLOUDFLARE_API_TOKEN &&
      (hasAccessWork(desired, this.access, this.reachableAddresses()) || this.launcherWork())
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
      if (!row || row.repo !== deployer.repo) return fail(404, "kitshn knows no such deploy of this repo.");
      if (row.expires_at < Date.now() || row.state !== "planned")
        return fail(410, "This deploy expired or ended. Run it again.");
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
      if (result.kind !== "teardown" || !own) {
        return Response.json(
          {
            error: `The token names no pull request, and ${event.branch} deployed no preview pr-${event.pr}.`,
          },
          { status: 403 },
        );
      }
    }
    const compose = "compose" in recipe ? recipe.compose : null;
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
        machineId = existing.machine;
      } else if (result.kind === "deploy") {
        const labels = compose.runsOn ?? [];
        const pick = [...this.state.machines.values()]
          // Only a machine that the owner labels "deploy" runs the apps of repos (K-610).
          .filter((machine) => ["deploy", ...labels].every((label) => machine.labels.includes(label)))
          .filter((machine) => this.machineView(machine).status?.capabilities?.includes("compose"))
          .sort((a, b) => a.order - b.order)
          .find((machine) => this.presence.get(machine.id)?.online);
        if (!pick) {
          return Response.json(
            {
              error: `No online machine with a Compose-ready daemon has the labels ${["deploy", ...labels].join(", ")}. Label a machine "deploy", update its daemon, or start it.`,
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
      `INSERT INTO deploys (id, repo, environment, resource_id, address, script, starts_in, kind, sha, state, expires_at, branch, app, machine_id, compose_file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?)`,
      deployId,
      deployer.repo,
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
    const circle = row.starts_in
      ? [...this.state.circles.values()].find((item) =>
          [item.id, item.name.toLowerCase()].includes(row.starts_in!.toLowerCase()),
        )
      : undefined;
    const place = circle ? placeInside(this.state, { x: circle.x, y: circle.y }, new Set([circle.id])) : null;
    if (circle && place) {
      this.commit(
        actor,
        resolveEdits(this.state, [{ _tag: "place", id: row.resource_id, after: place }]),
        null,
      );
      return `The card starts in ${circle.name} (K-807).`;
    }
    this.insertRevision(actor, `Deployed ${row.repo} ${row.environment}`, [], null);
    this.load();
    return "The card waits in the tray, so the site is private until you share it on the map (K-509).";
  }

  /** K-812: the source archive and the params of a Compose deploy go to R2 until the job ends. */
  private async deployFile(path: string, deployer: Deployer, request: Request) {
    const fail = (status: number, error: string) => Response.json({ error }, { status });
    const [row] = this.sql<DeployRow>(
      "SELECT * FROM deploys WHERE id = ?",
      request.headers.get("x-kitshn-deploy") ?? "",
    );
    if (!row || row.repo !== deployer.repo || row.app !== "compose" || row.kind !== "deploy")
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
    try {
      await bucket.put(
        deployObject(row.id, path === "/deploy/archive" ? "source.tgz" : "params.env"),
        readable,
      );
      await piped;
    } catch (error) {
      await piped.catch(() => undefined);
      return fail(502, `The upload did not reach R2: ${String(error)}`);
    }
    return Response.json({ ok: true });
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
    const object = await this.env.BUCKET?.get(deployObject(deployId, file));
    if (!object) return new Response("The file of this deploy is gone.", { status: 404 });
    return new Response(object.body);
  }

  /** K-812: makes the card and its Access application, then sends the Compose job to the chosen machine. */
  private async startCompose(api: Api, row: DeployRow, deployer: Deployer) {
    const machine = row.machine_id ? this.state.machines.get(row.machine_id) : undefined;
    if (!machine) return Response.json({ error: "The machine of this deploy is gone." }, { status: 409 });
    const card = this.ensureCard(row, deployer, "site.compose", machine.id);
    // Fail closed: the Access application exists before the tunnel sends the address to the app (K-410).
    await this.withAccessLock(() =>
      syncAccess(
        desiredAccess(this.state, Date.now()),
        this.accessStore(),
        api,
        this.env.CLOUDFLARE_ACCOUNT_ID,
        20,
        this.reachableAddresses(),
      ),
    );
    const app = this.access.get(`app:${row.resource_id}:${row.address}`);
    if (!app?.cfId || app.error)
      return Response.json(
        {
          error: `The Access application of ${row.address} is not ready: ${app?.error ?? "pending"}. Run the deploy again.`,
        },
        { status: 503 },
      );
    const command: Command = {
      kind: "compose",
      deployId: row.id,
      project: row.resource_id,
      name: row.address.slice(0, -this.env.KITSHN_ZONE.length - 1),
      environment: row.environment,
      repo: row.repo,
      file: row.compose_file,
    };
    const now = Date.now();
    const jobId = this.ctx.storage.transactionSync(() => {
      const [inserted] = this.sql<{ id: number }>(
        `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, exit_code, output)
         VALUES (?, '[]', ?, 'queued', ?, ?, ?, '${KITSHN_JOB}', NULL, '') RETURNING id`,
        machine.id,
        JSON.stringify(command),
        now,
        now + DEPLOY_MS,
        JSON.stringify({ _tag: "kitshn", reason: `deploy of ${row.repo}` }),
      );
      this.sql("UPDATE deploys SET state = 'running', job_id = ? WHERE id = ?", inserted?.id ?? null, row.id);
      return inserted?.id ?? null;
    });
    if (jobId === null) throw new Error("The job insert returned no id.");
    this.deliverJobs();
    this.broadcast();
    return Response.json({ machine: machine.name, card });
  }

  /** K-813: the state and output of a Compose deploy, for the Actions step that waits on it. */
  private composeStatus(deployer: Deployer, deployId: string) {
    const [row] = this.sql<DeployRow>("SELECT * FROM deploys WHERE id = ?", deployId);
    if (!row || row.repo !== deployer.repo || row.job_id === null)
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
    const name = row.address.slice(0, -this.env.KITSHN_ZONE.length - 1);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      if (machineId)
        this.sql(
          `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, exit_code, output)
           VALUES (?, '[]', ?, 'queued', ?, ?, ?, '${KITSHN_JOB}', NULL, '')`,
          machineId,
          JSON.stringify({
            kind: "compose-down",
            project: row.resource_id,
            name,
            removeData: true,
          } satisfies Command),
          now,
          now + JOB_EXPIRY_MS,
          JSON.stringify({
            _tag: "kitshn",
            reason: `pull request closed in ${row.repo}, ${deployer.sha.slice(0, 7)}`,
          }),
        );
      this.sql("UPDATE deploys SET state = 'done' WHERE id = ?", row.id);
      // A preview that never came up has no live site to take its card away.
      if (resource && ![...this.liveSites.values()].some((site) => site.id === row.resource_id)) {
        for (const table of ["resources", "places"])
          this.sql(`DELETE FROM ${table} WHERE id = ?`, row.resource_id);
        this.sql("DELETE FROM share_settings WHERE id LIKE ?", `${row.resource_id}/%`);
      }
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
    await this.withAccessLock(() =>
      syncAccess(
        desiredAccess(this.state, Date.now()),
        this.accessStore(),
        api,
        this.env.CLOUDFLARE_ACCOUNT_ID,
        20,
        this.reachableAddresses(),
      ),
    );
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
    this.sql("UPDATE deploys SET state = 'done' WHERE id = ?", row.id);
    this.load();
    this.broadcast();
    void this.scheduleAlarm();
    return Response.json({ address: row.address, status: check?.status ?? 0, card });
  }

  /** K-904: a closed pull request removes its preview: the address, the Worker, the card and its Access app. */
  private async teardown(api: Api, row: DeployRow, deployer: Deployer) {
    const account = `/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}`;
    const domains = await api<Array<{ id: string; service: string }>>(
      "GET",
      `${account}/workers/domains?hostname=${encodeURIComponent(row.address)}`,
    );
    for (const domain of domains.filter((item) => item.service === row.script)) {
      await api("DELETE", `${account}/workers/domains/${domain.id}`);
    }
    // K-006: the card, and with it the Access application, goes only after the address is confirmed gone.
    const left = await api<Array<{ service: string }>>(
      "GET",
      `${account}/workers/domains?hostname=${encodeURIComponent(row.address)}`,
    );
    if (left.some((item) => item.service === row.script)) {
      throw new Error(`${row.address} still serves ${row.script}; run the teardown again.`);
    }
    await api("DELETE", `${account}/workers/scripts/${row.script}?force=true`).catch((error: unknown) =>
      error instanceof CloudflareError && error.status === 404 ? undefined : Promise.reject(error),
    );
    const resource = this.state.resources.get(row.resource_id);
    this.ctx.storage.transactionSync(() => {
      for (const table of ["resources", "places"])
        this.sql(`DELETE FROM ${table} WHERE id = ?`, row.resource_id);
      this.sql("DELETE FROM share_settings WHERE id LIKE ?", `${row.resource_id}/%`);
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
      for (const table of ["library", "resources", "places"])
        this.sql(`DELETE FROM ${table} WHERE id = ?`, id);
      this.sql("DELETE FROM share_settings WHERE id LIKE ?", `${id}/%`);
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
        desiredAccess(this.state, Date.now()),
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
    return desiredAccess(this.state, Date.now()).policies.has(ENROLLMENT_KEY)
      ? this.access.get(ENROLLMENT_KEY)?.cfId || ""
      : "";
  }

  /** K-113: the App Launcher lacks the wanted policy, and that change did not fail since the daily retry. */
  private launcherWork() {
    const want = this.launcherWant();
    return want !== (this.meta("launcher_policy") ?? "") && this.meta("launcher_failed") !== `failed:${want}`;
  }

  private accessLock: Promise<unknown> = Promise.resolve();

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
          "INSERT OR REPLACE INTO access_objects (key, cf_id, body, tried, error) VALUES (?, ?, ?, ?, ?)",
          row.key,
          row.cfId,
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
    const before = JSON.stringify(accessStates(desiredAccess(this.state, now), this.access));
    this.endShares(now);
    const daily = this.dailyAt() <= now;
    if (daily) this.daily(now);
    const api = this.api();
    if (api) {
      const desired = desiredAccess(this.state, now);
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
      // Removals first: ingress and DNS go before an Access application does. Additions wait for the next
      // run, because ingress and DNS need the application that the Access sync makes (K-410).
      await this.syncTunnels(api, 6);
      spent += await this.checkSites(api, 6);
      await this.syncDns(api, 5);
      await this.syncRoutes(api, 5);
      // K-113: take an unwanted enrollment policy off the App Launcher before the sync deletes it.
      spent += await this.syncLauncher(api, daily);
      await this.withAccessLock(() =>
        // The state can change while the daily compare waits, so the sync reads it inside the lock.
        syncAccess(
          desiredAccess(this.state, Date.now()),
          this.accessStore(),
          api,
          this.env.CLOUDFLARE_ACCOUNT_ID,
          // The tunnels, DNS records and offline routes above used at most 16 calls, and the
          // launcher step below needs 3 (K-406).
          CALLS_PER_RUN - spent - 19,
          this.reachableAddresses(),
        ),
      );
      // A policy that the sync just made goes on the App Launcher in the same run.
      await this.syncLauncher(api, false);

      changed ||=
        daily || JSON.stringify(accessStates(desiredAccess(this.state, now), this.access)) !== before;
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

interface DeployRow extends Record<string, SqlStorageValue> {
  id: string;
  repo: string;
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
const KITSHN_JOB = JSON.stringify({ email: null, clientId: null, ip: null, kitshn: true });
