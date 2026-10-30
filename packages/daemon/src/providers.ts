// K-704 to K-707: the providers of this machine. A provider belongs to the local connection that registered it; the
// daemon keeps the last registration of each one in `providers.json`, so kitshn keeps its cards while it restarts.
import {
  type CardSettingValues,
  type DesiredParts,
  type GrantTables,
  type ProviderAccess,
  type ReachedCard,
  type ProviderReport,
  type ProviderRefusal,
  type ProviderRequest,
  type ProviderResource,
  decodeProviderReports,
  PROVIDER_LIMITS,
  isProviderName,
  pushKey,
  reportProblem,
} from "@kitshn/local";
import { Schema } from "effect";
import { RESERVED_SITE_NAMES } from "kitshn/names";

interface Entry {
  readonly report: ProviderReport;
  /** The local connection that registered it; null while it is offline. */
  readonly connection: number | null;
  /** K-704: while it has no connection: since when, and why. */
  readonly offline?: { readonly at: number; readonly reason: string };
}

/** K-704: why a provider that `providers.json` kept has no connection after a daemon start. */
export const NEVER_CONNECTED = "never connected since the daemon started";

/**
 * What `providers.json` holds: the providers without their connections, and the last push of kitshn for each key
 * (K-1608): `grants:<provider>`, `settings:<provider>` and `desired:<provider>:<kind>`.
 */
interface Saved {
  readonly providers: ReadonlyArray<ProviderReport>;
  readonly pushed: Readonly<Record<string, unknown>>;
  /** K-704: the user id that each provider name belongs to; the first accepted `register` binds it. */
  readonly owners?: Readonly<Record<string, number>>;
}

/** A refusal reason fits the text of a notification (K-1901). */
const MAX_REFUSAL_LENGTH = 500;

const decodePushed = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * K-1608: the saved state of `providers.json`, item by item: a provider or an owner that does not decode is left
 * out and named in `problems`, and the rest loads. Only a file that is no object at all starts empty. An owner of
 * -1, which a Windows daemon saved before it stopped binding (K-621), is such an item.
 */
export function parseSaved(value: unknown): { saved: Saved; problems: ReadonlyArray<string> } {
  const empty: Saved = { providers: [], pushed: {} };
  if (value === null) return { saved: empty, problems: [] };
  if (!isRecord(value)) return { saved: empty, problems: ["the file holds no object, so no provider loads"] };
  const problems: Array<string> = [];
  const providers: Array<ProviderReport> = [];
  for (const [index, item] of (Array.isArray(value["providers"]) ? value["providers"] : []).entries())
    try {
      const [report] = decodeProviderReports([item]);
      if (report) providers.push({ ...report, online: false });
    } catch (error) {
      problems.push(`providers[${index}] dropped: ${String(error)}`);
    }
  const owners: Record<string, number> = {};
  for (const [name, uid] of Object.entries(isRecord(value["owners"]) ? value["owners"] : {}))
    if (typeof uid === "number" && Number.isSafeInteger(uid) && uid >= 0) owners[name] = uid;
    else problems.push(`the owner of ${name} dropped: ${JSON.stringify(uid)} is no user id`);
  let pushed: Readonly<Record<string, unknown>> = {};
  try {
    pushed = decodePushed(value["pushed"] ?? {});
  } catch (error) {
    problems.push(`the saved pushes dropped: ${String(error)}`);
  }
  return { saved: { providers, pushed, owners }, problems };
}

/** The outcome of one provider request: an error text, or what changed. */
export type ProviderOutcome =
  { readonly ok: false; readonly error: string } | { readonly ok: true; readonly changed: boolean };

export class Providers {
  private readonly entries = new Map<string, Entry>();
  // Known limit: memory only, so a daemon restart forgets a refusal until the provider tries again.
  private readonly refusals = new Map<string, ProviderRefusal>();
  private pushed: Record<string, unknown>;
  private readonly owners: Map<string, number>;

  constructor(
    saved: Saved,
    private readonly save: (saved: Saved) => void,
    /** K-704: a refusal or a connection changed, so the status of the machine changed. */
    private readonly refusalsChanged: () => void,
    startedAt = Date.now(),
  ) {
    for (const report of saved.providers)
      this.entries.set(report.name, {
        report: { ...report, online: false },
        connection: null,
        offline: { at: startedAt, reason: NEVER_CONNECTED },
      });
    this.pushed = { ...saved.pushed };
    this.owners = new Map(Object.entries(saved.owners ?? {}));
  }

  /** K-704: the user id that a provider name belongs to, or undefined before its first accepted `register`. */
  ownerOf(provider: string): number | undefined {
    return this.owners.get(provider);
  }

  /** K-704, K-1751: the provider names that belong to a user id, so its attester prefix is one of them. */
  ownedBy(uid: number): Array<string> {
    return [...this.owners].filter(([, owner]) => owner === uid).map(([name]) => name);
  }

  /**
   * K-704: moves a provider name to another user id. The cards stay the same cards; a connection of the old user
   * goes offline, so its next request must `register` again, which the new bind refuses.
   */
  rebind(provider: string, uid: number): string | null {
    const entry = this.entries.get(provider);
    if (!entry) return `this machine has no provider ${provider}.`;
    this.owners.set(provider, uid);
    if (entry.connection !== null) {
      this.entries.set(provider, {
        report: { ...entry.report, online: false },
        connection: null,
        offline: { at: Date.now(), reason: `it moved to the user id ${uid}` },
      });
      this.refusalsChanged();
    }
    this.persist();
    return null;
  }

  /** K-704 to K-705: applies one request of the connection `connection`; `takenSites` are the names of `sites.json`. */
  apply(
    request: Exclude<ProviderRequest, { type: "command-result" }>,
    connection: number,
    takenSites: ReadonlySet<string>,
    uid: number,
    /** The daemon user or root, who may claim a provider saved before binds existed. */
    privileged: boolean,
  ): ProviderOutcome {
    const old = this.entries.get(request.provider);
    const owner = this.owners.get(request.provider);
    // Neither refusal marks the provider as refused: it belongs to another user, who still runs it (K-704).
    if (request.type === "register" && owner !== undefined && owner !== uid)
      return {
        ok: false,
        error: `${request.provider} belongs to the user id ${owner}, not to ${uid}; root or the daemon user moves it with kitshn providers rebind ${request.provider} --to-user <user> (K-704).`,
      };
    if (request.type === "register" && owner === undefined && old !== undefined && !privileged)
      return {
        ok: false,
        error: `${request.provider} was saved before providers had users; root or the daemon user registers it or moves it with kitshn providers rebind ${request.provider} --to-user <user> (K-704).`,
      };
    if (request.type !== "register" && old?.connection !== connection)
      return { ok: false, error: `register ${request.provider} on this connection first (K-704).` };
    const report: ProviderReport =
      request.type === "register"
        ? {
            name: request.provider,
            online: true,
            kinds: request.kinds,
            commands: request.commands,
            resources: request.resources,
            ...(request.clients ? { clients: request.clients } : {}),
          }
        : { ...old!.report, resources: changedResources(old!.report.resources, request) };
    const others = [...this.entries.values()]
      .map((entry) => entry.report)
      .filter((other) => other.name !== request.provider);
    const problem = reportProblem(report, others, takenSites, RESERVED_SITE_NAMES);
    if (problem) {
      const error = `${request.provider}: ${problem}`;
      if (request.type === "register") this.refuse(request.provider, error);
      return { ok: false, error };
    }
    if (request.type === "register" && this.refusals.delete(request.provider)) this.refusalsChanged();
    this.entries.set(request.provider, { report, connection });
    // K-704: a provider that comes back changes the status of the machine.
    if (old !== undefined && old.connection === null) this.refusalsChanged();
    // K-621: Windows has no user ids, and its pipe admits only the daemon's own account, so nothing to bind there.
    const bound = request.type === "register" && owner === undefined && uid >= 0;
    if (bound) this.owners.set(request.provider, uid);
    const changed = JSON.stringify(old?.report) !== JSON.stringify(report);
    if (changed || bound) this.persist();
    return { ok: true, changed };
  }

  /**
   * K-704: keeps the refusal of a registration until the next accepted one. A provider retries the same request, so
   * `at` stays the start of the refusal with this reason.
   */
  refuse(provider: string, reason: string, now = Date.now()): void {
    if (!isProviderName(provider)) return;
    const clipped = reason.slice(0, MAX_REFUSAL_LENGTH);
    if (this.refusals.get(provider)?.reason === clipped) return;
    this.refusals.delete(provider);
    this.refusals.set(provider, { provider, reason: clipped, at: now });
    // A machine has at most 8 providers (K-704); the oldest refusal goes first.
    for (const name of this.refusals.keys())
      if (this.refusals.size > PROVIDER_LIMITS.providers) this.refusals.delete(name);
    this.refusalsChanged();
  }

  refused(): Array<ProviderRefusal> {
    return [...this.refusals.values()];
  }

  /** K-704: drops a provider that no connection holds, so the daemon no longer reports it; or says why not. */
  forget(provider: string): string | null {
    const entry = this.entries.get(provider);
    if (!entry) return `this machine has no provider ${provider}.`;
    if (entry.connection !== null) return `${provider} is connected; stop it first.`;
    this.entries.delete(provider);
    this.owners.delete(provider);
    for (const key of Object.keys(this.pushed))
      if (
        key === pushKey.grants(provider) ||
        key === pushKey.settings(provider) ||
        key === pushKey.reach(provider) ||
        key === pushKey.access(provider) ||
        key.startsWith(`desired:${provider}:`)
      )
        delete this.pushed[key];
    this.persist();
    return null;
  }

  /** K-704: the providers of a closed connection go offline; their cards stay. Returns true when one did. */
  disconnect(connection: number, now = Date.now()): boolean {
    let changed = false;
    for (const [name, entry] of this.entries)
      if (entry.connection === connection) {
        this.entries.set(name, {
          report: { ...entry.report, online: false },
          connection: null,
          offline: { at: now, reason: "the connection closed" },
        });
        changed = true;
      }
    if (changed) {
      this.persist();
      this.refusalsChanged();
    }
    return changed;
  }

  /** K-704, K-515: the registered providers without a connection now, since when and why. */
  offline(): Array<{ readonly provider: string; readonly reason: string; readonly at: number }> {
    return [...this.entries].flatMap(([provider, entry]) =>
      entry.connection === null && entry.offline
        ? [{ provider, reason: entry.offline.reason, at: entry.offline.at }]
        : [],
    );
  }

  /** The connection of an online provider, or null. */
  connectionOf(provider: string): number | null {
    return this.entries.get(provider)?.connection ?? null;
  }

  reports(): Array<ProviderReport> {
    return [...this.entries.values()].map((entry) => entry.report);
  }

  /** K-1104: the live sites of the providers' cards, served from local ports. */
  sites(): Array<{ readonly name: string; readonly target: string; readonly dev: boolean }> {
    return this.reports().flatMap((report) =>
      report.resources.flatMap((resource) =>
        resource.site
          ? [{ name: resource.site.name, target: `http://localhost:${resource.site.port}`, dev: false }]
          : [],
      ),
    );
  }

  /** K-706: stores the tables that kitshn sent; true when they differ from the last ones. */
  /** K-1608: stores the push of kitshn with this key; true when it differs from the last one. */
  setPushed(key: string, value: unknown): boolean {
    if (JSON.stringify(this.pushed[key]) === JSON.stringify(value)) return false;
    this.pushed[key] = value;
    this.persist();
    return true;
  }

  /** K-706, K-709, K-717: what the answer to `register` gives a provider from the saved pushes. */
  savedFor(provider: string): {
    readonly grants: GrantTables;
    readonly desired: Record<string, DesiredParts>;
    readonly settings: CardSettingValues;
    readonly reach: ReadonlyArray<ReachedCard>;
    readonly access: ProviderAccess | null;
  } {
    const prefix = `desired:${provider}:`;
    return {
      grants: (this.pushed[pushKey.grants(provider)] as GrantTables | undefined) ?? {},
      desired: Object.fromEntries(
        Object.entries(this.pushed).flatMap(([key, value]) =>
          key.startsWith(prefix) ? [[key.slice(prefix.length), value as DesiredParts]] : [],
        ),
      ),
      settings: (this.pushed[pushKey.settings(provider)] as CardSettingValues | undefined) ?? {},
      reach: this.reachOf(provider),
      access: (this.pushed[pushKey.access(provider)] as ProviderAccess | undefined) ?? null,
    };
  }

  /** A saved push of kitshn by its key, or null. */
  pushedValue(key: string): unknown {
    return this.pushed[key] ?? null;
  }

  /** K-1609: the saved reach of a provider: the cards on other machines that this machine opens. */
  reachOf(provider: string): ReadonlyArray<ReachedCard> {
    return (this.pushed[pushKey.reach(provider)] as ReadonlyArray<ReachedCard> | undefined) ?? [];
  }

  private persist() {
    this.save({
      // The saved flag says whether a connection holds the provider now; a start reads every one as offline.
      providers: this.reports(),
      pushed: this.pushed,
      owners: Object.fromEntries(this.owners),
    });
  }
}

function changedResources(
  resources: ReadonlyArray<ProviderResource>,
  request: Extract<ProviderRequest, { type: "upsert" | "remove" }>,
): Array<ProviderResource> {
  if (request.type === "remove") {
    const gone = new Set(request.ids);
    return resources.filter((resource) => !gone.has(resource.id));
  }
  const next = new Map(resources.map((resource) => [resource.id, resource]));
  for (const resource of request.resources) next.set(resource.id, resource);
  return [...next.values()];
}
