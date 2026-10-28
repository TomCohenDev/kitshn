/** K-1303: the free plan limits of the account that the Usage view measures, and how to read the raw numbers. */

/** Daily limits reset at 00:00 UTC, monthly ones on the first of the month; "now" is a count or a size now. */
export type UsagePeriod = "day" | "month" | "now";

export interface UsageRow {
  readonly label: string;
  readonly used: number;
  readonly limit: number;
  readonly period: UsagePeriod;
  readonly unit: "count" | "bytes";
  /** The Cloudflare page that names the limit. */
  readonly docs: string;
}

export interface Usage {
  /** When kitshn read the numbers; the Durable Object keeps them for 5 minutes (K-1305). */
  readonly at: number;
  readonly rows: ReadonlyArray<UsageRow>;
  /** A part that kitshn could not read, with the reason; the other rows still show. */
  readonly errors: ReadonlyArray<string>;
}

/** K-1303: a row warns at 80% of its limit. */
export const USAGE_WARNING = 0.8;

export const usageLevel = (row: UsageRow): "ok" | "warn" | "full" =>
  row.used >= row.limit ? "full" : row.used >= row.limit * USAGE_WARNING ? "warn" : "ok";

const GB = 1_000_000_000;
const DO_DOCS = "https://developers.cloudflare.com/durable-objects/platform/pricing/";
const KV_DOCS = "https://developers.cloudflare.com/kv/platform/pricing/";
const R2_DOCS = "https://developers.cloudflare.com/r2/pricing/";
const ACCESS_DOCS = "https://developers.cloudflare.com/cloudflare-one/account-limits/";

/** The answer of the one GraphQL Analytics query of K-1303 (`USAGE_QUERY`). */
export interface Analytics {
  readonly workers: ReadonlyArray<{ readonly sum: { readonly requests: number } }>;
  readonly objects: ReadonlyArray<{ readonly sum: { readonly requests: number } }>;
  readonly rows: ReadonlyArray<{ readonly sum: { readonly rowsRead: number; readonly rowsWritten: number } }>;
  readonly objectStorage: ReadonlyArray<{ readonly max: { readonly storedBytes: number } }>;
  readonly kv: ReadonlyArray<{
    readonly sum: { readonly requests: number };
    readonly dimensions: { readonly actionType: string };
  }>;
  readonly kvStorage: ReadonlyArray<{ readonly max: { readonly byteCount: number } }>;
  readonly r2: ReadonlyArray<{
    readonly sum: { readonly requests: number };
    readonly dimensions: { readonly actionType: string };
  }>;
  readonly r2Storage: ReadonlyArray<{
    readonly max: { readonly payloadSize: number; readonly metadataSize: number };
  }>;
}

/**
 * Daily datasets filter on `$day`, monthly R2 operations on `$month`. R2 storage is the newest value of each bucket.
 * Known limit: the R2 free operations count per calendar month, while Cloudflare counts per billing month.
 */
export const USAGE_QUERY = `query ($account: String!, $day: Date!, $since: Time!, $monthSince: Time!, $until: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workers: workersInvocationsAdaptive(limit: 1, filter: { datetime_geq: $since, datetime_leq: $until }) { sum { requests } }
    objects: durableObjectsInvocationsAdaptiveGroups(limit: 1, filter: { date: $day }) { sum { requests } }
    rows: durableObjectsPeriodicGroups(limit: 1, filter: { date: $day }) { sum { rowsRead rowsWritten } }
    objectStorage: durableObjectsStorageGroups(limit: 1, filter: { date: $day }) { max { storedBytes } }
    kv: kvOperationsAdaptiveGroups(limit: 10, filter: { date: $day }) { sum { requests } dimensions { actionType } }
    kvStorage: kvStorageAdaptiveGroups(limit: 1000, filter: { date: $day }) { max { byteCount } dimensions { namespaceId } }
    r2: r2OperationsAdaptiveGroups(limit: 100, filter: { datetime_geq: $monthSince, datetime_leq: $until }) { sum { requests } dimensions { actionType } }
    r2Storage: r2StorageAdaptiveGroups(limit: 100, filter: { datetime_geq: $since, datetime_leq: $until }) { max { payloadSize metadataSize } dimensions { bucketName } }
  } }
}`;

/** The variables of `USAGE_QUERY` at `now`. */
export function usageVariables(account: string, now: number) {
  const day = new Date(now).toISOString().slice(0, 10);
  return {
    account,
    day,
    since: `${day}T00:00:00Z`,
    monthSince: `${day.slice(0, 7)}-01T00:00:00Z`,
    until: new Date(now).toISOString(),
  };
}

/** R2 classes from the [pricing page](https://developers.cloudflare.com/r2/pricing/); the free ones count in neither. */
const R2_CLASS_A = new Set([
  "ListBuckets",
  "PutBucket",
  "ListObjects",
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "LifecycleStorageTierTransition",
  "ListMultipartUploads",
  "UploadPart",
  "UploadPartCopy",
  "ListParts",
  "PutBucketEncryption",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
]);
const R2_CLASS_B = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);
const R2_FREE = new Set(["DeleteObject", "DeleteObjects", "DeleteBucket", "AbortMultipartUpload"]);

const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0);

/** The rows from the analytics; rows read come first, because they ran out first (2026-10-28). */
export function analyticsRows(data: Analytics): { rows: Array<UsageRow>; errors: Array<string> } {
  const errors: Array<string> = [];
  const kv = (action: string) =>
    sum(data.kv.filter((group) => group.dimensions.actionType === action).map((group) => group.sum.requests));
  let classA = 0;
  let classB = 0;
  for (const group of data.r2) {
    const action = group.dimensions.actionType;
    if (R2_CLASS_B.has(action)) classB += group.sum.requests;
    else if (R2_CLASS_A.has(action)) classA += group.sum.requests;
    else if (!R2_FREE.has(action)) {
      // A class that the pricing page does not name yet counts as class A, the smaller limit, and says so.
      classA += group.sum.requests;
      errors.push(`R2 action ${action} is not on the pricing page; kitshn counts it as class A.`);
    }
  }
  const rows = data.rows[0]?.sum ?? { rowsRead: 0, rowsWritten: 0 };
  return {
    errors,
    rows: [
      {
        label: "Durable Object rows read",
        used: rows.rowsRead,
        limit: 5_000_000,
        period: "day",
        unit: "count",
        docs: DO_DOCS,
      },
      {
        label: "Durable Object rows written",
        used: rows.rowsWritten,
        limit: 100_000,
        period: "day",
        unit: "count",
        docs: DO_DOCS,
      },
      {
        label: "Worker requests",
        used: data.workers[0]?.sum.requests ?? 0,
        limit: 100_000,
        period: "day",
        unit: "count",
        docs: "https://developers.cloudflare.com/workers/platform/limits/",
      },
      {
        label: "Durable Object requests",
        used: data.objects[0]?.sum.requests ?? 0,
        limit: 100_000,
        period: "day",
        unit: "count",
        docs: DO_DOCS,
      },
      {
        label: "Durable Object storage",
        used: data.objectStorage[0]?.max.storedBytes ?? 0,
        limit: 5 * GB,
        period: "now",
        unit: "bytes",
        docs: DO_DOCS,
      },
      { label: "KV reads", used: kv("read"), limit: 100_000, period: "day", unit: "count", docs: KV_DOCS },
      { label: "KV writes", used: kv("write"), limit: 1_000, period: "day", unit: "count", docs: KV_DOCS },
      { label: "KV deletes", used: kv("delete"), limit: 1_000, period: "day", unit: "count", docs: KV_DOCS },
      { label: "KV lists", used: kv("list"), limit: 1_000, period: "day", unit: "count", docs: KV_DOCS },
      {
        label: "KV storage",
        used: sum(data.kvStorage.map((group) => group.max.byteCount)),
        limit: 1 * GB,
        period: "now",
        unit: "bytes",
        docs: KV_DOCS,
      },
      {
        label: "R2 class A operations",
        used: classA,
        limit: 1_000_000,
        period: "month",
        unit: "count",
        docs: R2_DOCS,
      },
      {
        label: "R2 class B operations",
        used: classB,
        limit: 10_000_000,
        period: "month",
        unit: "count",
        docs: R2_DOCS,
      },
      {
        label: "R2 storage",
        used: sum(data.r2Storage.map((group) => group.max.payloadSize + group.max.metadataSize)),
        limit: 10 * GB,
        period: "now",
        unit: "bytes",
        docs: R2_DOCS,
      },
    ],
  };
}

/** The counts that the REST API gives, one call each. */
export interface Counts {
  readonly seats: number;
  readonly applications: number;
  readonly serviceTokens: number;
  readonly scripts: number;
  /** Each zone with its records and its limit (K-1111: 200 for a Free zone made after 2024-09-01, else 1,000). */
  readonly zones: ReadonlyArray<{
    readonly name: string;
    readonly records: number;
    readonly createdOn: string;
  }>;
}

export const dnsLimit = (createdOn: string) => (createdOn >= "2024-09-01" ? 200 : 1_000);

export function countRows(counts: Counts): Array<UsageRow> {
  return [
    {
      label: "Access seats",
      used: counts.seats,
      limit: 50,
      period: "now",
      unit: "count",
      docs: "https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/",
    },
    {
      label: "Access applications",
      used: counts.applications,
      limit: 500,
      period: "now",
      unit: "count",
      docs: ACCESS_DOCS,
    },
    {
      label: "Access service tokens",
      used: counts.serviceTokens,
      limit: 50,
      period: "now",
      unit: "count",
      docs: ACCESS_DOCS,
    },
    {
      label: "Worker scripts",
      used: counts.scripts,
      limit: 100,
      period: "now",
      unit: "count",
      docs: "https://developers.cloudflare.com/workers/platform/limits/",
    },
    ...counts.zones.map((zone) => ({
      label: `DNS records of ${zone.name}`,
      used: zone.records,
      limit: dnsLimit(zone.createdOn),
      period: "now" as const,
      unit: "count" as const,
      docs: "https://developers.cloudflare.com/dns/faq/",
    })),
  ];
}
