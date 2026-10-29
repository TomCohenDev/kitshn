// K-704 to K-707: the providers of this machine. A provider belongs to the local connection that registered it; the
// daemon keeps the last registration of each one in `providers.json`, so kitshn keeps its cards while it restarts.
import {
  GrantTables,
  type ProviderReport,
  type ProviderRequest,
  type ProviderResource,
  decodeProviderReports,
  reportProblem,
} from "@kitshn/local";
import { Schema } from "effect";
import { RESERVED_SITE_NAMES } from "kitshn/names";

interface Entry {
  readonly report: ProviderReport;
  /** The local connection that registered it; null while it is offline. */
  readonly connection: number | null;
}

/** What `providers.json` holds: the providers without their connections, and the grant tables that kitshn sent. */
interface Saved {
  readonly providers: ReadonlyArray<ProviderReport>;
  readonly grants: Readonly<Record<string, GrantTables>>;
}

const decodeGrants = Schema.decodeUnknownSync(Schema.Record(Schema.String, GrantTables));

/** K-1608: the saved state of `providers.json`; a file that does not decode starts empty, and says why. */
export function parseSaved(value: unknown): { saved: Saved; problem: string | null } {
  if (value === null) return { saved: { providers: [], grants: {} }, problem: null };
  try {
    const record = value as { providers?: unknown; grants?: unknown };
    return {
      saved: {
        providers: decodeProviderReports(record.providers).map((report) => ({ ...report, online: false })),
        grants: decodeGrants(record.grants ?? {}),
      },
      problem: null,
    };
  } catch (error) {
    return { saved: { providers: [], grants: {} }, problem: String(error) };
  }
}

/** The outcome of one provider request: an error text, or what changed. */
export type ProviderOutcome =
  { readonly ok: false; readonly error: string } | { readonly ok: true; readonly changed: boolean };

export class Providers {
  private readonly entries = new Map<string, Entry>();
  private grants: Record<string, GrantTables>;

  constructor(
    saved: Saved,
    private readonly save: (saved: Saved) => void,
  ) {
    for (const report of saved.providers) this.entries.set(report.name, { report, connection: null });
    this.grants = { ...saved.grants };
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
    delete this.grants[provider];
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
  setGrants(provider: string, tables: GrantTables): boolean {
    if (JSON.stringify(this.grants[provider]) === JSON.stringify(tables)) return false;
    this.grants[provider] = tables;
    this.persist();
    return true;
  }

  grantsOf(provider: string): GrantTables {
    return this.grants[provider] ?? {};
  }

  private persist() {
    this.save({
      providers: this.reports().map((report) => ({ ...report, online: false })),
      grants: this.grants,
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
