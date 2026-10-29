// K-704 to K-707: the providers of this machine. A provider belongs to the local connection that registered it; the
// daemon keeps the last registration of each one in `providers.json`, so kitshn keeps its cards while it restarts.
import {
  type CardSettingValues,
  type DesiredParts,
  type GrantTables,
  type ReachedCard,
  type ProviderReport,
  type ProviderRequest,
  type ProviderResource,
  decodeProviderReports,
  pushKey,
  reportProblem,
} from "@kitshn/local";
import { Schema } from "effect";
import { RESERVED_SITE_NAMES } from "kitshn/names";

interface Entry {
  readonly report: ProviderReport;
  /** The local connection that registered it; null while it is offline. */
  readonly connection: number | null;
}

/**
 * What `providers.json` holds: the providers without their connections, and the last push of kitshn for each key
 * (K-1608): `grants:<provider>`, `settings:<provider>` and `desired:<provider>:<kind>`.
 */
interface Saved {
  readonly providers: ReadonlyArray<ProviderReport>;
  readonly pushed: Readonly<Record<string, unknown>>;
}

const decodePushed = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

/** K-1608: the saved state of `providers.json`; a file that does not decode starts empty, and says why. */
export function parseSaved(value: unknown): { saved: Saved; problem: string | null } {
  if (value === null) return { saved: { providers: [], pushed: {} }, problem: null };
  try {
    const record = value as { providers?: unknown; pushed?: unknown };
    return {
      saved: {
        providers: decodeProviderReports(record.providers).map((report) => ({ ...report, online: false })),
        pushed: decodePushed(record.pushed ?? {}),
      },
      problem: null,
    };
  } catch (error) {
    return { saved: { providers: [], pushed: {} }, problem: String(error) };
  }
}

/** The outcome of one provider request: an error text, or what changed. */
export type ProviderOutcome =
  { readonly ok: false; readonly error: string } | { readonly ok: true; readonly changed: boolean };

export class Providers {
  private readonly entries = new Map<string, Entry>();
  private pushed: Record<string, unknown>;

  constructor(
    saved: Saved,
    private readonly save: (saved: Saved) => void,
  ) {
    for (const report of saved.providers) this.entries.set(report.name, { report, connection: null });
    this.pushed = { ...saved.pushed };
  }

  /** K-704 to K-705: applies one request of the connection `connection`; `takenSites` are the names of `sites.json`. */
  apply(
    request: Exclude<ProviderRequest, { type: "command-result" }>,
    connection: number,
    takenSites: ReadonlySet<string>,
  ): ProviderOutcome {
    const old = this.entries.get(request.provider);
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
          }
        : { ...old!.report, resources: changedResources(old!.report.resources, request) };
    const others = [...this.entries.values()]
      .map((entry) => entry.report)
      .filter((other) => other.name !== request.provider);
    const problem = reportProblem(report, others, takenSites, RESERVED_SITE_NAMES);
    if (problem) return { ok: false, error: `${request.provider}: ${problem}` };
    this.entries.set(request.provider, { report, connection });
    const changed = JSON.stringify(old?.report) !== JSON.stringify(report);
    if (changed) this.persist();
    return { ok: true, changed };
  }

  /** K-704: drops a provider that no connection holds, so the daemon no longer reports it; or says why not. */
  forget(provider: string): string | null {
    const entry = this.entries.get(provider);
    if (!entry) return `this machine has no provider ${provider}.`;
    if (entry.connection !== null) return `${provider} is connected; stop it first.`;
    this.entries.delete(provider);
    for (const key of Object.keys(this.pushed))
      if (
        key === pushKey.grants(provider) ||
        key === pushKey.settings(provider) ||
        key === pushKey.reach(provider) ||
        key.startsWith(`desired:${provider}:`)
      )
        delete this.pushed[key];
    this.persist();
    return null;
  }

  /** K-704: the providers of a closed connection go offline; their cards stay. Returns true when one did. */
  disconnect(connection: number): boolean {
    let changed = false;
    for (const [name, entry] of this.entries)
      if (entry.connection === connection) {
        this.entries.set(name, { report: { ...entry.report, online: false }, connection: null });
        changed = true;
      }
    if (changed) this.persist();
    return changed;
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
      providers: this.reports().map((report) => ({ ...report, online: false })),
      pushed: this.pushed,
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
