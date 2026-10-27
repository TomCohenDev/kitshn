import { ACCESS_NAME_PREFIX, type AppBody, type DesiredAccess, type PolicyBody } from "../core/access.ts";
import { deepEqual } from "../core/changes.ts";
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
const PAGE = 1000;

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

const policyIds = (body: string) =>
  (JSON.parse(body) as { policies?: ReadonlyArray<{ id: string }> }).policies?.map((policy) => policy.id) ??
  [];

const removesPolicy = (before: string, after: string) => {
  const kept = new Set(policyIds(after));
  return policyIds(before).some((id) => !kept.has(id));
};

interface Named {
  readonly id: string;
  readonly name: string;
  readonly domain?: string;
}

interface LivePolicy extends Named {
  readonly decision: string;
  readonly include: unknown;
  readonly require: unknown;
  readonly exclude: unknown;
}

interface LiveApp extends Named {
  readonly session_duration?: string;
  readonly policies?: ReadonlyArray<{ readonly id: string }>;
}

/**
 * K-408, the daily run: reads Access in two calls and marks each object that someone changed or deleted,
 * so the next sync writes it again. The lists carry no MFA settings, so a changed passkey setting is not
 * seen here; revisit if the list API adds `mfa_config`. Returns warnings for applications that kitshn did
 * not make but that cover a kitshn address; kitshn never changes those.
 */
export async function verifyAccess(
  desired: DesiredAccess,
  store: AccessStore,
  api: Api,
  accountId: string,
): Promise<Array<string>> {
  const base = `/accounts/${accountId}/access`;
  const policies = await api<ReadonlyArray<LivePolicy>>("GET", `${base}/policies?per_page=${PAGE}`);
  const apps = await api<ReadonlyArray<LiveApp>>("GET", `${base}/apps?per_page=${PAGE}`);
  // A full page can hide objects on a next page; then "missing" means nothing, so kitshn compares nothing.
  if (policies.length >= PAGE || apps.length >= PAGE) {
    return ["The account has too many Access objects for the daily compare (K-408), so kitshn skipped it."];
  }
  for (const row of store.rows.values()) {
    // A pending attempt (a failed write or revoke) is retried by the sync itself; comparing it here would
    // drop the old body that the session revoke of K-409 needs.
    if (!row.cfId || !row.body || (row.tried !== "" && row.tried !== row.body)) continue;
    const ours = JSON.parse(row.body) as Record<string, unknown>;
    let same: boolean;
    if (row.key.startsWith("policy:")) {
      const live = policies.find((policy) => policy.id === row.cfId);
      same =
        live !== undefined &&
        deepEqual(
          {
            name: live.name,
            decision: live.decision,
            include: live.include,
            require: live.require,
            exclude: live.exclude,
          },
          {
            name: ours["name"],
            decision: ours["decision"],
            include: ours["include"],
            require: ours["require"],
            exclude: ours["exclude"],
          },
        );
      if (!live) store.put({ ...row, cfId: "", body: "", tried: "", error: null });
      else if (!same) store.put({ ...row, body: "", tried: "", error: null });
      continue;
    }
    const live = apps.find((app) => app.id === row.cfId);
    same =
      live !== undefined &&
      deepEqual(
        {
          name: live.name,
          domain: live.domain,
          session: live.session_duration,
          policies: live.policies?.map((p) => p.id) ?? [],
        },
        {
          name: ours["name"],
          domain: ours["domain"],
          session: ours["session_duration"],
          policies: policyIds(row.body),
        },
      );
    if (!live) store.put({ ...row, cfId: "", body: "", tried: "", error: null });
    else if (!same) store.put({ ...row, body: "", tried: "", error: null });
  }
  const ours = new Set([...store.rows.values()].map((row) => row.cfId));
  const warnings: Array<string> = [];
  for (const app of desired.apps.values()) {
    for (const live of apps) {
      if (live.domain === app.domain && !ours.has(live.id)) {
        warnings.push(
          `The Access application "${live.name}" also covers ${app.domain}. kitshn did not make it and does not change it.`,
        );
      }
    }
  }
  return warnings;
}

/** K-110: ends the sessions of every application that kitshn made. It never touches other applications. */
export async function signOutEverywhere(
  store: AccessStore,
  api: Api,
  accountId: string,
): Promise<{ ended: number; failed: Array<string> }> {
  let ended = 0;
  const failed: Array<string> = [];
  const apps = [...store.rows.values()].filter((row) => row.key.startsWith("app:") && row.cfId);
  for (const [index, row] of apps.entries()) {
    if (index >= CALLS_PER_RUN) {
      failed.push(`${apps.length - index} more applications (the call limit of one request)`);
      break;
    }
    try {
      await api("POST", `/accounts/${accountId}/access/apps/${row.cfId}/revoke_tokens`);
      ended++;
    } catch (error) {
      failed.push(`${row.key}: ${message(error)}`);
    }
  }
  return { ended, failed };
}

/**
 * K-408 for the passkey check (K-103): the policy lists carry no MFA settings, so this reads each policy
 * that needs a passkey once a day and marks it when someone changed its MFA settings. It reads at most
 * `budget` policies a day, which covers 10 passkey circles; revisit when an owner has more.
 */
export async function verifyPasskeys(
  store: AccessStore,
  api: Api,
  accountId: string,
  budget: number,
): Promise<number> {
  let calls = 0;
  for (const row of store.rows.values()) {
    if (calls >= budget) break;
    if (!row.key.startsWith("policy:") || !row.cfId || !row.body) continue;
    const ours = (
      JSON.parse(row.body) as {
        mfa_config?: { allowed_authenticators: Array<string>; session_duration: string };
      }
    ).mfa_config;
    if (!ours) continue;
    calls++;
    const live = await api<{
      mfa_config?: {
        allowed_authenticators?: Array<string>;
        session_duration?: string;
        mfa_disabled?: boolean;
      } | null;
    }>("GET", `/accounts/${accountId}/access/policies/${row.cfId}`);
    const same =
      live.mfa_config?.mfa_disabled !== true &&
      deepEqual(
        [...(live.mfa_config?.allowed_authenticators ?? [])].sort(),
        [...ours.allowed_authenticators].sort(),
      ) &&
      live.mfa_config?.session_duration === ours.session_duration;
    if (!same) store.put({ ...row, body: "", tried: "", error: null });
  }
  return calls;
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
      // K-409: a removed share takes effect at once, so the sessions of the application end. Until the
      // revoke succeeds, the row keeps its old body, so the next run writes and revokes again.
      if (kind === "apps" && row?.body && removesPolicy(row.body, body)) {
        if (!spend()) {
          store.put({ key, cfId: result.id, body: row.body, tried: "", error: null });
          return false;
        }
        try {
          await api("POST", `${base}/apps/${result.id}/revoke_tokens`);
        } catch (error) {
          store.put({
            key,
            cfId: result.id,
            body: row.body,
            tried: body,
            error: `sessions not ended: ${message(error)}`,
          });
          return true;
        }
      }
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
