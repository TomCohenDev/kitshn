import { ACCESS_NAME_PREFIX, type AppBody, type DesiredAccess, type PolicyBody } from "../core/access.ts";
import type { AccessState } from "../core/protocol.ts";

/**
 * What kitshn knows about one Access object. `body` is the JSON that Cloudflare last accepted ("" when
 * none). `tried` is the JSON of the last attempt; with `error` set, that attempt failed.
 */
export interface AccessRow {
  readonly key: string;
  readonly cfId: string;
  readonly body: string;
  readonly tried: string;
  readonly error: string | null;
}

export interface AccessStore {
  readonly rows: ReadonlyMap<string, AccessRow>;
  put(row: AccessRow): void;
  remove(key: string): void;
}

export type Api = <T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<T>;

/** K-406: one alarm run makes at most this many Cloudflare API calls. */
export const CALLS_PER_RUN = 40;

const policyBody = (policy: PolicyBody) => JSON.stringify(policy);

/** True when an attempt with this body failed and waits for the daily retry (K-408). */
const failedWith = (row: AccessRow | undefined, body: string) => row?.error != null && row.tried === body;

/**
 * The application body, or null while it must wait. A policy without a Cloudflare id is left out only
 * when the result takes access away from what Cloudflare has (fails closed). Otherwise the application
 * waits for that policy, so a failed create never empties an application.
 */
function appBody(key: string, app: AppBody, rows: ReadonlyMap<string, AccessRow>): string | null {
  const ids = app.policyKeys.map((policyKey) => rows.get(policyKey)?.cfId ?? "").filter((id) => id !== "");
  if (ids.length < app.policyKeys.length) {
    const row = rows.get(key);
    if (!row?.body) return null;
    const written = new Set(
      (JSON.parse(row.body) as { policies: Array<{ id: string }> }).policies.map((p) => p.id),
    );
    if (!ids.every((id) => written.has(id))) return null;
  }
  const { policyKeys: _, ...rest } = app;
  return JSON.stringify({ ...rest, policies: ids.map((id, index) => ({ id, precedence: index + 1 })) });
}

/** K-407: the Access state of each card with an application. */
export function accessStates(
  desired: DesiredAccess,
  rows: ReadonlyMap<string, AccessRow>,
): Record<string, AccessState> {
  const states: Record<string, AccessState> = {};
  for (const [key, app] of desired.apps) {
    const resourceId = key.split(":")[1] ?? key;
    const parts = [
      ...app.policyKeys.map((policyKey) => {
        const policy = desired.policies.get(policyKey);
        return { row: rows.get(policyKey), body: policy ? policyBody(policy) : "" };
      }),
      { row: rows.get(key), body: appBody(key, app, rows) ?? "" },
    ];
    const failed = parts.find((part) => failedWith(part.row, part.body));
    const state: AccessState = failed?.row?.error
      ? { state: "failed", error: failed.row.error }
      : parts.every((part) => part.row?.cfId && part.row.body === part.body)
        ? { state: "applied" }
        : { state: "applying" };
    const previous = states[resourceId];
    if (!previous || previous.state === "applied") states[resourceId] = state;
  }
  return states;
}

/** True when some object needs a write that is not waiting for the daily retry. */
export function hasAccessWork(desired: DesiredAccess, rows: ReadonlyMap<string, AccessRow>): boolean {
  for (const [key, policy] of desired.policies) {
    const body = policyBody(policy);
    if (rows.get(key)?.body !== body && !failedWith(rows.get(key), body)) return true;
  }
  for (const [key, app] of desired.apps) {
    const body = appBody(key, app, rows);
    if (body !== null && rows.get(key)?.body !== body && !failedWith(rows.get(key), body)) return true;
  }
  for (const row of rows.values()) if (isStale(desired, row)) return true;
  return false;
}

/** A row that kitshn no longer wants. A failed deletion waits for the daily retry (K-408). */
const isStale = (desired: DesiredAccess, row: AccessRow) =>
  !desired.policies.has(row.key) && !desired.apps.has(row.key) && row.error === null;

const isNotFound = (error: unknown) =>
  typeof error === "object" && error !== null && "status" in error && error.status === 404;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface Named {
  readonly id: string;
  readonly name: string;
  readonly domain?: string;
}

/**
 * K-406: brings Access to the desired state in at most `budget` calls. Returns true when no work is left.
 * It adopts an object that it did not record only when its name starts with "kitshn " (K-408).
 */
export async function syncAccess(
  desired: DesiredAccess,
  store: AccessStore,
  api: Api,
  accountId: string,
  budget = CALLS_PER_RUN,
): Promise<boolean> {
  let calls = 0;
  const spend = () => calls++ < budget;
  const base = `/accounts/${accountId}/access`;
  let existingPolicies: ReadonlyArray<Named> | null = null;
  let existingApps: ReadonlyArray<Named> | null = null;

  const write = async (
    key: string,
    kind: "policies" | "apps",
    body: string,
    find: (list: ReadonlyArray<Named>) => Named | undefined,
  ) => {
    const row = store.rows.get(key);
    if (row?.body === body || failedWith(row, body)) return true;
    let cfId = row?.cfId ?? "";
    try {
      if (!cfId) {
        if (kind === "policies" && !existingPolicies) {
          if (!spend()) return false;
          existingPolicies = await api<ReadonlyArray<Named>>("GET", `${base}/policies?per_page=1000`);
        }
        if (kind === "apps" && !existingApps) {
          if (!spend()) return false;
          existingApps = await api<ReadonlyArray<Named>>("GET", `${base}/apps?per_page=1000`);
        }
        const found = find((kind === "policies" ? existingPolicies : existingApps) ?? []);
        cfId = found && found.name.startsWith(ACCESS_NAME_PREFIX) ? found.id : "";
      }
      if (!spend()) return false;
      const request: unknown = JSON.parse(body);
      const result = cfId
        ? await api<Named>("PUT", `${base}/${kind}/${cfId}`, request)
        : await api<Named>("POST", `${base}/${kind}`, request);
      store.put({ key, cfId: result.id, body, tried: body, error: null });
    } catch (error) {
      // Someone deleted the object: forget its id, so the next run creates it again.
      if (isNotFound(error) && cfId) store.put({ key, cfId: "", body: "", tried: "", error: null });
      else store.put({ key, cfId, body: row?.body ?? "", tried: body, error: message(error) });
    }
    return true;
  };

  for (const [key, policy] of desired.policies) {
    const found = (list: ReadonlyArray<Named>) => list.find((item) => item.name === policy.name);
    if (!(await write(key, "policies", policyBody(policy), found))) return false;
  }
  for (const [key, app] of desired.apps) {
    const body = appBody(key, app, store.rows);
    if (body === null) continue;
    const found = (list: ReadonlyArray<Named>) => list.find((item) => item.domain === app.domain);
    if (!(await write(key, "apps", body, found))) return false;
  }
  const stale = [...store.rows.values()].filter((row) => isStale(desired, row));
  // Applications first: Access refuses to delete a policy that an application still uses.
  stale.sort((a, b) => Number(a.key.startsWith("policy:")) - Number(b.key.startsWith("policy:")));
  for (const row of stale) {
    if (!row.cfId) {
      store.remove(row.key);
      continue;
    }
    if (!spend()) return false;
    const kind = row.key.startsWith("policy:") ? "policies" : "apps";
    try {
      await api("DELETE", `${base}/${kind}/${row.cfId}`);
      store.remove(row.key);
    } catch (error) {
      if (isNotFound(error)) store.remove(row.key);
      else store.put({ ...row, tried: "", error: message(error) });
    }
  }
  return true;
}
