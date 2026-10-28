import {
  type Analytics,
  PERMISSION,
  type Read,
  USAGE_QUERY,
  type Usage,
  analyticsRows,
  countRows,
  usageVariables,
} from "../core/usage.ts";
import { CloudflareError, cloudflare, cloudflareCount, cloudflareGraphql } from "./cloudflare.ts";
import type { Zone } from "./zones.ts";

/** The creation time of each zone; it never changes, so each isolate reads it once (K-1305). */
const zoneCreated = new Map<string, number>();

/** A failed call as the reason of its bar; a refused token names the permission that the part needs. */
const reasonOf =
  (permission: string) =>
  (error: unknown): Read => ({
    error:
      error instanceof CloudflareError && (error.status === 401 || error.status === 403)
        ? `The API token needs ${permission}. ${error.message}`
        : String(error),
  });

const settle = (permission: string, count: Promise<number>): Promise<Read> =>
  count.then((used) => ({ used }), reasonOf(permission));

/**
 * K-1303, K-1305: the free plan use of the account, from one GraphQL query, 4 REST counts, and one count per zone
 * (plus its creation date once). Each value fails on its own and then shows as unknown with its reason.
 */
export async function readUsage(
  token: string,
  account: string,
  zones: ReadonlyArray<Zone>,
  now: number,
): Promise<Usage> {
  const analytics = cloudflareGraphql<{ viewer: { accounts: ReadonlyArray<Analytics> } }>(
    token,
    USAGE_QUERY,
    usageVariables(account, now),
  ).then(
    ({ data, errors }) => ({ data: data.viewer.accounts[0] ?? {}, errors }),
    (error: unknown) => {
      const { error: reason } = reasonOf(PERMISSION.analytics)(error) as { error: string };
      return { data: {}, errors: Object.fromEntries(ANALYTICS_ALIASES.map((alias) => [alias, reason])) };
    },
  );
  const [graph, seats, applications, serviceTokens, scripts, zoneCounts] = await Promise.all([
    analytics,
    // Free Zero Trust has at most 50 seats, so one page of 1,000 users holds them all.
    settle(
      PERMISSION.seats,
      cloudflare<ReadonlyArray<{ access_seat: boolean; gateway_seat: boolean }>>(
        token,
        "GET",
        `/accounts/${account}/access/users?per_page=1000`,
      ).then((users) => {
        if (users.length >= 1000)
          throw new Error("the account has 1,000 Access users or more; kitshn reads one page.");
        return users.filter((user) => user.access_seat || user.gateway_seat).length;
      }),
    ),
    settle(PERMISSION.applications, cloudflareCount(token, `/accounts/${account}/access/apps`)),
    settle(PERMISSION.serviceTokens, cloudflareCount(token, `/accounts/${account}/access/service_tokens`)),
    settle(
      PERMISSION.scripts,
      cloudflare<ReadonlyArray<unknown>>(token, "GET", `/accounts/${account}/workers/scripts`).then(
        (list) => list.length,
      ),
    ),
    Promise.all(
      zones.map(async (zone) => ({
        name: zone.name,
        records: await settle(PERMISSION.dns, cloudflareCount(token, `/zones/${zone.id}/dns_records`)),
        createdOn: await settle(PERMISSION.zone, createdOf(token, zone.id)),
      })),
    ),
  ]);
  return {
    at: now,
    rows: [
      ...analyticsRows(graph.data, graph.errors),
      ...countRows({ seats, applications, serviceTokens, scripts, zones: zoneCounts }),
    ],
  };
}

const ANALYTICS_ALIASES: ReadonlyArray<keyof Analytics> = [
  "workers",
  "objects",
  "rows",
  "objectStorage",
  "d1",
  "d1Storage",
  "kv",
  "kvStorage",
  "r2",
  "r2Storage",
];

async function createdOf(token: string, zoneId: string): Promise<number> {
  const known = zoneCreated.get(zoneId);
  if (known !== undefined) return known;
  const zone = await cloudflare<{ created_on: string }>(token, "GET", `/zones/${zoneId}`);
  const created = Date.parse(zone.created_on);
  if (Number.isNaN(created)) throw new Error(`the zone has no readable creation date: ${zone.created_on}`);
  zoneCreated.set(zoneId, created);
  return created;
}
