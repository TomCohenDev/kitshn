import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";
import { desiredAccess } from "../core/access.ts";
import {
  type Actor,
  type Change,
  type Edit,
  RuleError,
  applyChanges,
  conflictOf,
  invert,
  resolveEdits,
  ruleViolation,
  summarize,
} from "../core/changes.ts";
import {
  ADMIN_RESOURCE_ID,
  type Circle,
  type Point,
  type Resource,
  type ShareSetting,
  type State,
  circlesHolding,
} from "../core/model.ts";
import { placeInside } from "../core/place.ts";
import type { RevisionView, ServerMessage, Snapshot } from "../core/protocol.ts";
import { ClientMessage } from "../core/schema.ts";
import { demo } from "../core/demo.ts";
import { seed } from "../core/seed.ts";
import { visitorLevel } from "../core/visitor.ts";
import { type AccessRow, accessStates, hasAccessWork, syncAccess } from "./access-sync.ts";
import type { Caller } from "./auth.ts";
import { cloudflare } from "./cloudflare.ts";
import type { Env } from "./env.ts";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS circles (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS resources (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS places (id TEXT PRIMARY KEY, x REAL NOT NULL, y REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS share_settings (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
    actor TEXT NOT NULL, summary TEXT NOT NULL, changes TEXT NOT NULL, undoes INTEGER)`,
  "CREATE TABLE IF NOT EXISTS access_objects (key TEXT PRIMARY KEY, cf_id TEXT NOT NULL, body TEXT NOT NULL, error TEXT)",
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
];

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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      for (const statement of SCHEMA) ctx.storage.sql.exec(statement);
      this.load();
      if (this.state.circles.size === 0) this.seed();
      this.syncAdminAddress();
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
    };
    this.access = new Map(
      this.sql<{ key: string; cf_id: string; body: string; error: string | null }>(
        "SELECT key, cf_id, body, error FROM access_objects",
      ).map((row) => [row.key, { key: row.key, cfId: row.cf_id, body: row.body, error: row.error }]),
    );
    const rows = this.sql<{ id: number; at: number; actor: string; summary: string; undoes: number | null }>(
      "SELECT id, at, actor, summary, undoes FROM revisions ORDER BY id DESC LIMIT ?",
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
    }));
  }

  private seed() {
    const emails = this.env.OWNER_EMAILS.split(",")
      .map((email) => email.trim())
      .filter(Boolean);
    if (emails.length === 0) throw new Error("OWNER_EMAILS is empty: kitshn cannot make the Owner circle.");
    const initial = seed(emails, this.env.KITSHN_HOST);
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
    this.revisions = [
      { id, at: Date.now(), actor, summary, undoes, undoneBy: null },
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
      me,
    };
  }

  private broadcast() {
    for (const socket of this.ctx.getWebSockets()) {
      const caller = socket.deserializeAttachment() as Caller;
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
    const header = request.headers.get("x-kitshn-caller");
    if (!header) return new Response("The Worker sent no caller.", { status: 500 });
    const caller = JSON.parse(header) as Caller;
    if (!this.authorized(caller)) {
      return Response.json(
        { error: "You have no control level on the kitshn admin (K-104)." },
        { status: 403 },
      );
    }
    const path = new URL(request.url).pathname;
    if (path === "/api/ws") {
      if (request.headers.get("upgrade") !== "websocket")
        return new Response("Expected a WebSocket.", { status: 426 });
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(caller);
      send(server, { type: "snapshot", snapshot: this.snapshot(caller.actor) });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (path === "/api/state" && request.method === "GET") return Response.json(this.snapshot(caller.actor));
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
    const caller = socket.deserializeAttachment() as Caller;
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
    send(socket, this.handle(caller, message));
  }

  /** K-1302: one alarm for the next due item. Access work, share end dates, and the daily run. */
  private async scheduleAlarm() {
    const now = Date.now();
    let next = this.dailyAt();
    const desired = desiredAccess(this.state, now);
    if (this.env.CLOUDFLARE_API_TOKEN && hasAccessWork(desired, this.access)) next = now;
    const ends = [
      ...[...this.state.shareSettings.values()].map((setting) => setting.endsAt),
      ...[...this.state.circles.values()].map((circle) => circle.endsAt),
    ];
    for (const end of ends) if (end !== null && end > now && end < next) next = end;
    if (ends.some((end) => end !== null && end <= now) && this.expiredShares(now).length > 0) next = now;
    const current = await this.ctx.storage.getAlarm();
    if (current !== next) await this.ctx.storage.setAlarm(next);
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
      this.sql(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('daily_at', ?)",
        String(nextUtcMidnight(now)),
      );
    });
    for (const row of this.access.values()) if (row.error) this.access.set(row.key, { ...row, error: null });
    this.load();
  }

  override async alarm() {
    const now = Date.now();
    this.endShares(now);
    if (this.dailyAt() <= now) this.daily(now);
    const token = this.env.CLOUDFLARE_API_TOKEN;
    if (token) {
      const store = {
        rows: this.access,
        put: (row: AccessRow) => {
          this.access.set(row.key, row);
          this.sql(
            "INSERT OR REPLACE INTO access_objects (key, cf_id, body, error) VALUES (?, ?, ?, ?)",
            row.key,
            row.cfId,
            row.body,
            row.error,
          );
        },
        remove: (key: string) => {
          this.access.delete(key);
          this.sql("DELETE FROM access_objects WHERE key = ?", key);
        },
      };
      const api = <T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) =>
        cloudflare<T>(token, method, path, body);
      await syncAccess(desiredAccess(this.state, now), store, api, this.env.CLOUDFLARE_ACCOUNT_ID);
      this.broadcast();
    }
    await this.scheduleAlarm();
  }
}

const send = (socket: WebSocket, message: ServerMessage) => socket.send(JSON.stringify(message));
