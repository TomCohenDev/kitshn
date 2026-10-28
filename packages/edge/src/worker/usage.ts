import {
  type Analytics,
  type Counts,
  USAGE_QUERY,
  type Usage,
  analyticsRows,
  countRows,
  usageVariables,
} from "../core/usage.ts";
import { cloudflare, cloudflareCount, cloudflareGraphql } from "./cloudflare.ts";
import type { Zone } from "./zones.ts";

/**
 * K-1303, K-1305: the free plan use of the account, from one GraphQL query and 4 + 2 per zone REST calls. A
 * part that fails gives an error line, and the other rows still show.
 */
export async function readUsage(
  token: string,
  account: string,
  zones: ReadonlyArray<Zone>,
  now: number,
): Promise<Usage> {
  const errors: Array<string> = [];
  const failed = (part: string) => (error: unknown) => {
    errors.push(`${part}: ${String(error)}`);
    return null;
  };
  const [analytics, counts] = await Promise.all([
    cloudflareGraphql<{ viewer: { accounts: ReadonlyArray<Analytics> } }>(
      token,
      USAGE_QUERY,
      usageVariables(account, now),
    )
      .then((data) => {
        const [first] = data.viewer.accounts;
        if (!first) throw new Error("the analytics answer holds no account.");
        return first;
      })
      .catch(failed("Analytics")),
    readCounts(token, account, zones).catch(failed("Counts")),
  ]);
  const fromAnalytics = analytics ? analyticsRows(analytics) : { rows: [], errors: [] };
  return {
    at: now,
    rows: [...fromAnalytics.rows, ...(counts ? countRows(counts) : [])],
    errors: [...errors, ...fromAnalytics.errors],
  };
}

async function readCounts(token: string, account: string, zones: ReadonlyArray<Zone>): Promise<Counts> {
  const [users, applications, serviceTokens, scripts, zoneCounts] = await Promise.all([
    // Free Zero Trust has at most 50 seats, so one page of 1,000 users holds them all.
    cloudflare<ReadonlyArray<{ access_seat: boolean }>>(
      token,
      "GET",
      `/accounts/${account}/access/users?per_page=1000`,
    ),
    cloudflareCount(token, `/accounts/${account}/access/apps`),
    cloudflareCount(token, `/accounts/${account}/access/service_tokens`),
    cloudflare<ReadonlyArray<unknown>>(token, "GET", `/accounts/${account}/workers/scripts`),
    Promise.all(
      zones.map(async (zone) => {
        const [records, details] = await Promise.all([
          cloudflareCount(token, `/zones/${zone.id}/dns_records`),
          cloudflare<{ created_on: string }>(token, "GET", `/zones/${zone.id}`),
        ]);
        return { name: zone.name, records, createdOn: details.created_on };
      }),
    ),
  ]);
  if (users.length >= 1000)
    throw new Error("the account has 1,000 Access users or more; kitshn reads one page only.");
  return {
    seats: users.filter((user) => user.access_seat).length,
    applications,
    serviceTokens,
    scripts: scripts.length,
    zones: zoneCounts,
  };
}
