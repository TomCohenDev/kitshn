// K-630: the health check of this machine: its providers, and each link of its reach through the link proxy path.
import {
  HEALTH_ERROR_MAX,
  HEALTH_MAX_LINKS,
  type HealthReport,
  type ProviderReport,
  type ReachedCard,
} from "@kitshn/local";
import { type MachineToken, linkHeaders, linkTarget } from "./link.ts";

/** K-630: a link that gives no answer in this time fails. */
const LINK_TIMEOUT_MS = 10_000;

/** One check result before the failures in a row are counted. */
interface Found {
  readonly error: string | null;
}

/**
 * K-630: a provider passes while a connection holds it. A refused `register` has its own sticker and notification
 * (K-704), so it is no health failure of its own. Known limit: a provider that hangs behind a live bridge passes here;
 * the link checks of the other machines find it. Revisit when providers answer a ping of their own.
 */
export const providerChecks = (
  reports: ReadonlyArray<ProviderReport>,
): Array<Found & { readonly provider: string }> =>
  reports.map((report) => ({
    provider: report.name,
    error: report.online ? null : "no connection holds the provider",
  }));

/** K-630: one link for each provider and machine of the reach that has an address, as the proxy picks it. */
export function linkPairs(
  providers: ReadonlyArray<string>,
  reachOf: (provider: string) => ReadonlyArray<ReachedCard>,
): Array<{ readonly provider: string; readonly machineId: string }> {
  const pairs = new Map<string, { provider: string; machineId: string }>();
  for (const provider of providers)
    for (const card of reachOf(provider))
      if (card.address !== null)
        pairs.set(`${provider}/${card.machineId}`, { provider, machineId: card.machineId });
  return [...pairs.values()].slice(0, HEALTH_MAX_LINKS);
}

/**
 * K-630: why an answer of the other machine means that the link does not work, or null. Any answer of its origin
 * passes, except 401 and 403, because the provider there then refuses this machine's token. Access refuses with a
 * redirect to its login, and the tunnel answers 502 or 530 when the origin does not run.
 */
export function linkVerdict(status: number, location: string | null): string | null {
  if (status >= 300 && status < 400 && location?.includes(".cloudflareaccess.com"))
    return "Access refused this machine's token";
  if (status === 401 || status === 403) return `refused this machine's token (${status})`;
  if (status >= 500) return `answered ${status}`;
  return null;
}

/** K-630: one cheap GET of `/` on the card's address, with the headers and the target of the link proxy (K-1609). */
export async function probeLink(
  reachOf: (provider: string) => ReadonlyArray<ReachedCard>,
  token: MachineToken | null,
  pair: { readonly provider: string; readonly machineId: string },
  fetcher: typeof fetch = fetch,
  scheme: "https" | "http" = "https",
): Promise<Found & { readonly status: number | null; readonly ms: number }> {
  const started = Date.now();
  const done = (status: number | null, error: string | null) => ({ status, error, ms: Date.now() - started });
  if (!token) return done(null, "the daemon has no machine token");
  const found = linkTarget(reachOf, new URL(`http://link/${pair.provider}/${pair.machineId}/`), scheme);
  if ("error" in found) return done(null, found.error);
  try {
    const answer = await fetcher(found.target, {
      headers: linkHeaders([], token),
      redirect: "manual",
      signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
    });
    await answer.body?.cancel();
    return done(answer.status, linkVerdict(answer.status, answer.headers.get("location")));
  } catch (error) {
    return done(null, `no answer from ${found.target.host}: ${String(error)}`);
  }
}

const clipError = (error: string | null) =>
  error === null || error.length <= HEALTH_ERROR_MAX ? error : `${error.slice(0, HEALTH_ERROR_MAX - 1)}…`;

/** K-630, K-631: counts the failures in a row of each check from the report before. */
export function nextReport(
  previous: HealthReport | null,
  providers: ReadonlyArray<Found & { readonly provider: string }>,
  links: ReadonlyArray<
    Found & {
      readonly provider: string;
      readonly machineId: string;
      readonly status: number | null;
      readonly ms: number;
    }
  >,
  now: number,
): HealthReport {
  const streak = (before: { failures: number; since: number | null } | undefined, error: string | null) =>
    error === null
      ? { failures: 0, since: null }
      : { failures: (before?.failures ?? 0) + 1, since: before?.since ?? now };
  return {
    at: now,
    providers: providers.slice(0, HEALTH_MAX_LINKS).map((check) => ({
      provider: check.provider,
      error: clipError(check.error),
      ...streak(
        previous?.providers.find((p) => p.provider === check.provider),
        check.error,
      ),
    })),
    links: links.slice(0, HEALTH_MAX_LINKS).map((check) => ({
      provider: check.provider,
      machineId: check.machineId,
      status: check.status,
      ms: check.ms,
      error: clipError(check.error),
      ...streak(
        previous?.links.find((l) => l.provider === check.provider && l.machineId === check.machineId),
        check.error,
      ),
    })),
  };
}
