import { describe, expect, it } from "vitest";
import { desiredAccess } from "../core/access.ts";
import { applyChanges, resolveEdits } from "../core/changes.ts";
import type { State } from "../core/model.ts";
import { seed } from "../core/seed.ts";
import {
  type AccessRow,
  type Api,
  accessStates,
  hasAccessWork,
  signOutEverywhere,
  syncAccess,
  syncLauncher,
  loginHeld,
  loginHeldAfter,
  loginWant,
  loginWarnings,
  syncLogins,
  syncWithLogins,
  verifyAccess,
} from "./access-sync.ts";

function start(): State {
  const s = seed(["owner@example.com"], "kit.example.com");
  return {
    circles: new Map(s.circles.map((circle) => [circle.id, circle])),
    resources: new Map(s.resources.map((resource) => [resource.id, resource])),
    places: new Map(s.places),
    shareSettings: new Map(),
    stacks: new Map(),
    paused: null,
    machines: new Map(),
  };
}

function fakeCloudflare(existing: { policies?: Array<object>; apps?: Array<object> } = {}) {
  const calls: Array<string> = [];
  let next = 0;
  const api: Api = async <T>(method: string, path: string) => {
    calls.push(`${method} ${path.replace("/accounts/a/access", "")}`);
    if (method === "GET")
      return (path.includes("/policies") ? (existing.policies ?? []) : (existing.apps ?? [])) as T;
    const id = method === "PUT" ? (path.split("/").pop() ?? "") : `id${++next}`;
    return { id } as T;
  };
  const rows = new Map<string, AccessRow>();
  const store = {
    rows,
    put: (row: AccessRow) => rows.set(row.key, row),
    remove: (key: string) => rows.delete(key),
  };
  return { api, calls, store, rows };
}

describe("Access sync (K-406, K-408)", () => {
  it("creates the Owner policy, then the admin application, then does nothing more", async () => {
    const cf = fakeCloudflare();
    const desired = desiredAccess(start(), 0);
    expect(await syncAccess(desired, cf.store, cf.api, "a")).toBe(true);
    // The Owner policy, its two login copies (K-1004) and the passkey enrollment policy (K-113), then the
    // admin application.
    expect(cf.calls).toEqual([
      "GET /policies?per_page=1000",
      "POST /policies",
      "POST /policies",
      "POST /policies",
      "POST /policies",
      "GET /apps?per_page=1000",
      "POST /apps",
    ]);
    expect(hasAccessWork(desired, cf.rows)).toBe(false);
    expect(accessStates(desired, cf.rows)).toEqual({ "kitshn-admin": { state: "applied" } });

    cf.calls.length = 0;
    await syncAccess(desired, cf.store, cf.api, "a");
    expect(cf.calls).toEqual([]);
  });

  it("adopts objects named kitshn and never others", async () => {
    const cf = fakeCloudflare({
      policies: [{ id: "p-old", name: "kitshn circle Owner" }],
      apps: [{ id: "app-t3", name: "T3 Code servers", domain: "kit.example.com" }],
    });
    await syncAccess(desiredAccess(start(), 0), cf.store, cf.api, "a");
    expect(cf.calls).toContain("PUT /policies/p-old");
    expect(cf.calls).toContain("POST /apps");
    expect(cf.calls).not.toContain("PUT /apps/app-t3");
  });

  it("removes the application before the policies it uses", async () => {
    const cf = fakeCloudflare();
    const state = start();
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const withoutAdmin: State = { ...state, resources: new Map() };
    cf.calls.length = 0;
    const appId = cf.rows.get("app:kitshn-admin:kit.example.com")!.cfId;
    const ownerId = cf.rows.get("policy:owner:people")!.cfId;
    const loginId = cf.rows.get("policy:owner:login")!.cfId;
    const passkeyId = cf.rows.get("policy:owner:login-passkey")!.cfId;
    await syncAccess(desiredAccess(withoutAdmin, 0), cf.store, cf.api, "a");
    expect(cf.calls).toEqual([
      `DELETE /apps/${appId}`,
      `DELETE /policies/${ownerId}`,
      `DELETE /policies/${loginId}`,
      `DELETE /policies/${passkeyId}`,
    ]);
    // The Owner circle still needs a passkey, so its people keep the enrollment policy (K-113).
    expect([...cf.rows.keys()]).toEqual(["policy:enrollment"]);
  });

  it("stops at the call budget and reports work left", async () => {
    const cf = fakeCloudflare();
    expect(await syncAccess(desiredAccess(start(), 0), cf.store, cf.api, "a", 2)).toBe(false);
    expect(cf.calls).toHaveLength(2);
  });

  it("marks a card failed and does not retry the same body", async () => {
    const cf = fakeCloudflare();
    const failing: Api = async (method, path, body) => {
      if (method === "POST" && path.endsWith("/apps")) throw new Error("refused");
      return cf.api(method, path, body);
    };
    const desired = desiredAccess(start(), 0);
    await syncAccess(desired, cf.store, failing, "a");
    expect(accessStates(desired, cf.rows)["kitshn-admin"]).toEqual({ state: "failed", error: "refused" });
    expect(hasAccessWork(desired, cf.rows)).toBe(false);
  });

  it("removes a share from the application even when the policy of a new share fails", async () => {
    const cf = fakeCloudflare();
    const state = start();
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const owner = state.circles.get("owner")!;
    const moved = applyChanges(
      state,
      resolveEdits(state, [
        { _tag: "circle", id: "others", after: { ...owner, id: "others", name: "Others", x: 5000 } },
        { _tag: "place", id: "kitshn-admin", after: { x: 5000, y: 40 } },
      ]),
    );
    const failing: Api = async (method, path, body) => {
      if (method === "POST" && path.endsWith("/policies")) throw new Error("refused");
      return cf.api(method, path, body);
    };
    await syncAccess(desiredAccess(moved, 0), cf.store, failing, "a");
    expect(JSON.parse(cf.rows.get("app:kitshn-admin:kit.example.com")!.body).policies).toEqual([]);
  });

  it("never empties an application when a policy create fails, and retries after the daily reset", async () => {
    const cf = fakeCloudflare({ apps: [{ id: "app-1", name: "kitshn admin", domain: "kit.example.com" }] });
    const desired = desiredAccess(start(), 0);
    const down: Api = async (method, path, body) => {
      if (path.includes("/policies")) throw new Error("503");
      return cf.api(method, path, body);
    };
    await syncAccess(desired, cf.store, down, "a");
    expect(cf.calls.filter((call) => call.includes("/apps/"))).toEqual([]);
    expect(hasAccessWork(desired, cf.rows)).toBe(false);

    for (const row of cf.rows.values()) cf.rows.set(row.key, { ...row, error: null });
    expect(hasAccessWork(desired, cf.rows)).toBe(true);
    await syncAccess(desired, cf.store, cf.api, "a");
    expect(JSON.parse(cf.rows.get("app:kitshn-admin:kit.example.com")!.body).policies).toHaveLength(1);
  });

  it("updates the policy when the circle changes", async () => {
    const cf = fakeCloudflare();
    const state = start();
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const owner = state.circles.get("owner")!;
    const changed = applyChanges(
      state,
      resolveEdits(state, [
        {
          _tag: "circle",
          id: "owner",
          after: { ...owner, members: [...owner.members, { _tag: "domain", domain: "x.com" }] },
        },
      ]),
    );
    const desired = desiredAccess(changed, 0);
    expect(accessStates(desired, cf.rows)["kitshn-admin"]).toEqual({ state: "applying" });
    cf.calls.length = 0;
    await syncAccess(desired, cf.store, cf.api, "a");
    // The new domain also may enroll a passkey (K-113).
    expect(cf.calls).toEqual([
      `PUT /policies/${cf.rows.get("policy:owner:people")!.cfId}`,
      `PUT /policies/${cf.rows.get("policy:owner:login")!.cfId}`,
      `PUT /policies/${cf.rows.get("policy:owner:login-passkey")!.cfId}`,
      `PUT /policies/${cf.rows.get("policy:enrollment")!.cfId}`,
    ]);
  });
});

describe("daily compare and sessions (K-408, K-409, K-110)", () => {
  it("rewrites an object that someone changed, and warns about a foreign application", async () => {
    const cf = fakeCloudflare();
    const desired = desiredAccess(start(), 0);
    await syncAccess(desired, cf.store, cf.api, "a");
    const adminId = cf.rows.get("app:kitshn-admin:kit.example.com")!.cfId;
    const enrollment = cf.rows.get("policy:enrollment")!;
    const login = cf.rows.get("policy:owner:login")!;
    const loginPasskey = cf.rows.get("policy:owner:login-passkey")!;
    const live: Api = async <T>(method: string, path: string) => {
      if (path.includes("/policies?"))
        return [
          {
            id: "id1",
            name: "kitshn circle Owner",
            decision: "allow",
            include: [{ everyone: {} }],
            require: [],
            exclude: [],
          },
          { id: enrollment.cfId, ...JSON.parse(enrollment.body) },
          { id: login.cfId, ...JSON.parse(login.body) },
          { id: loginPasskey.cfId, ...JSON.parse(loginPasskey.body) },
        ] as T;
      if (path.includes("/apps?"))
        return [
          {
            id: adminId,
            name: "kitshn admin",
            domain: "kit.example.com",
            session_duration: "24h",
            policies: [{ id: "id1" }],
          },
          { id: "x", name: "Someone else", domain: "kit.example.com" },
        ] as T;
      return cf.api(method as "GET", path);
    };
    const warnings = await verifyAccess(desired, cf.store, live, "a");
    expect(warnings).toEqual([expect.stringContaining("Someone else")]);
    expect(hasAccessWork(desired, cf.rows)).toBe(true);
    cf.calls.length = 0;
    await syncAccess(desired, cf.store, cf.api, "a");
    expect(cf.calls).toEqual(["PUT /policies/id1"]);
  });

  it("ends the sessions of an application that loses a policy, and of every kitshn application on sign out", async () => {
    const cf = fakeCloudflare();
    const state = start();
    const owner = state.circles.get("owner")!;
    const two = applyChanges(
      state,
      resolveEdits(state, [
        { _tag: "circle", id: "b", after: { ...owner, id: "b", name: "B", x: 0, y: 0, r: 100 } },
      ]),
    );
    await syncAccess(desiredAccess(two, 0), cf.store, cf.api, "a");
    cf.calls.length = 0;
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    expect(cf.calls).toContain(
      `POST /apps/${cf.rows.get("app:kitshn-admin:kit.example.com")!.cfId}/revoke_tokens`,
    );
    cf.calls.length = 0;
    expect(await signOutEverywhere(cf.store, cf.api, "a")).toEqual({ ended: 1, failed: [] });
    expect(cf.calls).toEqual([
      `POST /apps/${cf.rows.get("app:kitshn-admin:kit.example.com")!.cfId}/revoke_tokens`,
    ]);
  });

  it("retries a failed session revoke after the daily compare", async () => {
    const cf = fakeCloudflare();
    const state = start();
    const owner = state.circles.get("owner")!;
    const two = applyChanges(
      state,
      resolveEdits(state, [
        { _tag: "circle", id: "b", after: { ...owner, id: "b", name: "B", x: 0, y: 0, r: 100 } },
      ]),
    );
    await syncAccess(desiredAccess(two, 0), cf.store, cf.api, "a");
    const revokeFails: Api = async (method, path, body) => {
      if (path.endsWith("/revoke_tokens")) throw new Error("500");
      return cf.api(method, path, body);
    };
    const desired = desiredAccess(state, 0);
    await syncAccess(desired, cf.store, revokeFails, "a");
    for (const row of cf.rows.values()) cf.rows.set(row.key, { ...row, error: null });
    const appId = cf.rows.get("app:kitshn-admin:kit.example.com")!.cfId;
    const live: Api = async <T>(method: string, path: string) => {
      if (path.includes("/policies?")) return [] as T;
      if (path.includes("/apps?"))
        return [{ id: appId, name: "kitshn admin", domain: "kit.example.com", policies: [] }] as T;
      return cf.api(method as "GET", path);
    };
    await verifyAccess(desired, cf.store, live, "a");
    cf.calls.length = 0;
    await syncAccess(desired, cf.store, cf.api, "a");
    expect(cf.calls).toContain(`POST /apps/${appId}/revoke_tokens`);
  });

  it("keeps the Access app while a route can still reach its address (K-410)", async () => {
    const cf = fakeCloudflare();
    const state = start();
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const gone: State = { ...state, resources: new Map() };
    const desired = desiredAccess(gone, 0);
    // The ingress update that removes the site failed, so the old ingress still reaches kit.example.com.
    const reachable = new Set(["kit.example.com"]);
    cf.calls.length = 0;
    const loginId = cf.rows.get("policy:owner:login")!.cfId;
    const passkeyId = cf.rows.get("policy:owner:login-passkey")!.cfId;
    await syncAccess(desired, cf.store, cf.api, "a", 40, reachable);
    // Only the login copies go: no Access application of a card holds them (K-1004).
    expect(cf.calls.filter((call) => call.startsWith("DELETE"))).toEqual([
      `DELETE /policies/${loginId}`,
      `DELETE /policies/${passkeyId}`,
    ]);
    cf.calls.length = 0;
    expect(hasAccessWork(desired, cf.rows, reachable)).toBe(false);
    // Once the route is confirmed gone, the app goes, and then its policy.
    const appId = cf.rows.get("app:kitshn-admin:kit.example.com")!.cfId;
    const ownerId = cf.rows.get("policy:owner:people")!.cfId;
    await syncAccess(desired, cf.store, cf.api, "a", 40, new Set());
    expect(cf.calls.filter((call) => call.startsWith("DELETE"))).toEqual([
      `DELETE /apps/${appId}`,
      `DELETE /policies/${ownerId}`,
    ]);
  });

  it("keeps a reachable app also after the daily compare cleared its body (K-410)", async () => {
    const cf = fakeCloudflare();
    const state = start();
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const key = "app:kitshn-admin:kit.example.com";
    cf.rows.set(key, { ...cf.rows.get(key)!, body: "", tried: "" });
    const desired = desiredAccess({ ...state, resources: new Map() }, 0);
    cf.calls.length = 0;
    await syncAccess(desired, cf.store, cf.api, "a", 40, new Set(["kit.example.com"]));
    expect(cf.calls.filter((call) => call.startsWith("DELETE"))).toEqual([]);
  });
});

describe("passkey enrollment on the App Launcher (K-113)", () => {
  function launcherCloudflare(policies: Array<{ id: string; precedence?: number }>) {
    const cf = fakeCloudflare();
    const puts: Array<unknown> = [];
    const launcher = {
      id: "launcher",
      uid: "u",
      type: "app_launcher",
      name: "App Launcher",
      domain: "team",
      policies,
    };
    const api: Api = async <T>(method: string, path: string, body?: unknown) => {
      if (path.endsWith("/apps/launcher") && method === "GET") return launcher as T;
      if (path.includes("/apps?")) return [{ id: "other", type: "self_hosted" }, launcher] as T;
      if (method === "PUT" && path.endsWith("/apps/launcher")) {
        puts.push(body);
        return {} as T;
      }
      return cf.api(method as "GET", path, body);
    };
    return { ...cf, api, puts };
  }

  it("keeps the precedence of the other policies and goes after them", async () => {
    const cf = launcherCloudflare([
      { id: "block", precedence: 3 },
      { id: "t3-owner", precedence: 1 },
    ]);
    const state = start();
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const enrollment = cf.rows.get("policy:enrollment")!.cfId;
    await syncLauncher(desiredAccess(state, 0), cf.store, cf.api, "a", null, false);
    expect(cf.puts).toEqual([
      expect.objectContaining({
        policies: [
          { id: "block", precedence: 3 },
          { id: "t3-owner", precedence: 1 },
          { id: enrollment, precedence: 4 },
        ],
      }),
    ]);
  });

  it("leaves out circles that would let in more people, and keeps only Owner during a pause", () => {
    const state = start();
    const owner = state.circles.get("owner")!;
    const strict = {
      ...owner,
      id: "strict",
      name: "Strict",
      match: "all" as const,
      members: [{ _tag: "domain" as const, domain: "corp.com" }],
    };
    const withStrict = { ...state, circles: new Map(state.circles).set("strict", strict) };
    expect(desiredAccess(withStrict, 0).policies.get("policy:enrollment")?.include).toEqual([
      { email: { email: "owner@example.com" } },
    ]);
    const guests = {
      ...owner,
      id: "guests",
      name: "Guests",
      members: [{ _tag: "email" as const, email: "g@x.com" }],
    };
    const paused = { ...state, paused: "lockdown" as const, circles: new Map(state.circles).set("guests", guests) };
    expect(desiredAccess(paused, 0).policies.get("policy:enrollment")?.include).toEqual([
      { email: { email: "owner@example.com" } },
    ]);
  });

  it("adds the policy next to the old ones, keeps every other field, and takes back only its own", async () => {
    const cf = launcherCloudflare([{ id: "t3-owner" }]);
    const state = start();
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const enrollment = cf.rows.get("policy:enrollment")!.cfId;
    const added = await syncLauncher(desiredAccess(state, 0), cf.store, cf.api, "a", null, false);
    expect(added.attached).toBe(enrollment);
    expect(cf.puts).toEqual([
      {
        type: "app_launcher",
        name: "App Launcher",
        domain: "team",
        policies: [
          { id: "t3-owner", precedence: 1 },
          { id: enrollment, precedence: 2 },
        ],
      },
    ]);
    // Nothing changed: no Cloudflare call.
    expect(await syncLauncher(desiredAccess(state, 0), cf.store, cf.api, "a", enrollment, false)).toEqual({
      attached: enrollment,
      calls: 0,
    });
    // No passkey circle any more: only the kitshn policy leaves the App Launcher.
    const owner = state.circles.get("owner")!;
    const relaxed = {
      ...state,
      circles: new Map(state.circles).set("owner", { ...owner, needsPasskey: false }),
    };
    const launcher = launcherCloudflare([{ id: "t3-owner" }, { id: enrollment }]);
    const removed = await syncLauncher(
      desiredAccess(relaxed, 0),
      cf.store,
      launcher.api,
      "a",
      enrollment,
      false,
    );
    expect(removed.attached).toBeNull();
    expect(launcher.puts).toEqual([
      expect.objectContaining({ policies: [{ id: "t3-owner", precedence: 1 }] }),
    ]);
  });
});

describe("page and file logins (K-1004)", () => {
  const anyLogin = { id: "any", name: "kitshn any login" };
  const anyPasskey = { id: "any-passkey", name: "kitshn any login (passkey)" };

  function loginCloudflare(
    fail: (path: string) => boolean = () => false,
    attachMachines = true,
    listMachines = true,
  ) {
    const cf = fakeCloudflare();
    const puts: Array<{ path: string; body: unknown }> = [];
    const machines = { id: "machines", name: "kitshn machines", precedence: 2 };
    const apps = ["pages", "files"].flatMap((host) => [
      {
        id: `${host}-login`,
        uid: `${host}-login`,
        aud: "x",
        created_at: "2026-10-27T00:00:00Z",
        updated_at: "2026-10-27T00:00:00Z",
        type: "self_hosted",
        name: `kitshn ${host} login`,
        domain: `${host}.example.com/login`,
        destinations: [{ type: "public", uri: `${host}.example.com/login` }],
        self_hosted_domains: [`${host}.example.com/login`],
        session_duration: "720h",
        same_site_cookie_attribute: "lax",
        allowed_idps: ["otp"],
        scim_config: { enabled: false },
        policies: attachMachines ? [{ ...anyLogin, precedence: 1 }, machines] : [{ ...anyLogin, precedence: 1 }],
      },
      {
        id: `${host}-passkey`,
        aud: "y",
        name: `kitshn ${host} login (passkey)`,
        domain: `${host}.example.com/login/passkey`,
        policies: [{ ...anyPasskey, precedence: 1 }],
      },
    ]);
    const api: Api = async <T>(method: string, path: string, body?: unknown) => {
      if (path.includes("/apps?")) return apps as T;
      if (path.includes("/policies?"))
        return (listMachines ? [anyLogin, anyPasskey, machines] : [anyLogin, anyPasskey]) as T;
      if (fail(path)) throw new Error("refused");
      if (method === "PUT") puts.push({ path, body });
      return cf.api(method as "GET", path, body);
    };
    return { ...cf, api, puts };
  }

  it("replaces the any-login policies with the circles' people, keeps machines, and deletes the old ones", async () => {
    const cf = loginCloudflare();
    const desired = desiredAccess(start(), 0);
    await syncAccess(desired, cf.store, cf.api, "a");
    const plain = cf.rows.get("policy:owner:login")!.cfId;
    const passkey = cf.rows.get("policy:owner:login-passkey")!.cfId;
    cf.calls.length = 0;
    const result = await syncLogins(desired, cf.store, cf.api, "a", "example.com", "", false);
    expect(cf.puts).toEqual([
      {
        path: "/accounts/a/access/apps/pages-login",
        body: {
          type: "self_hosted",
          name: "kitshn pages login",
          domain: "pages.example.com/login",
          destinations: [{ type: "public", uri: "pages.example.com/login" }],
          self_hosted_domains: ["pages.example.com/login"],
          session_duration: "720h",
          same_site_cookie_attribute: "lax",
          allowed_idps: ["otp"],
          policies: [
            { id: "machines", precedence: 1 },
            { id: plain, precedence: 2 },
          ],
        },
      },
      expect.objectContaining({ body: expect.objectContaining({ policies: [{ id: passkey, precedence: 1 }] }) }),
      expect.objectContaining({ path: "/accounts/a/access/apps/files-login" }),
      expect.objectContaining({ path: "/accounts/a/access/apps/files-passkey" }),
    ]);
    expect(cf.calls.filter((call) => call.startsWith("DELETE"))).toEqual([
      "DELETE /policies/any",
      "DELETE /policies/any-passkey",
    ]);
    expect(result.calls).toBe(8);
    // Nothing changed: no Cloudflare call.
    expect(await syncLogins(desired, cf.store, cf.api, "a", "example.com", result.attached, false)).toEqual({
      attached: result.attached,
      calls: 0,
    });
  });

  it("writes the other applications when one fails, keeps the old policy it still uses, and throws", async () => {
    const cf = loginCloudflare((path) => path.endsWith("/apps/files-login"));
    const desired = desiredAccess(start(), 0);
    await syncAccess(desired, cf.store, cf.api, "a");
    cf.calls.length = 0;
    await expect(syncLogins(desired, cf.store, cf.api, "a", "example.com", "", false)).rejects.toThrow(
      "files.example.com/login: refused",
    );
    expect(cf.puts.map((put) => put.path)).toEqual([
      "/accounts/a/access/apps/pages-login",
      "/accounts/a/access/apps/pages-passkey",
      "/accounts/a/access/apps/files-passkey",
    ]);
    expect(cf.calls.filter((call) => call.startsWith("DELETE"))).toEqual(["DELETE /policies/any-passkey"]);
  });

  it("leaves out a policy that Cloudflare does not hold as written", async () => {
    const cf = loginCloudflare();
    const desired = desiredAccess(start(), 0);
    await syncAccess(desired, cf.store, cf.api, "a");
    const row = cf.rows.get("policy:owner:login")!;
    cf.rows.set(row.key, { ...row, body: "" });
    await syncLogins(desired, cf.store, cf.api, "a", "example.com", "", false);
    expect(cf.puts[0]).toEqual(
      expect.objectContaining({ body: expect.objectContaining({ policies: [{ id: "machines", precedence: 1 }] }) }),
    );
  });

  it("puts the machines policy back on /login when someone took it off", async () => {
    const cf = loginCloudflare(undefined, false);
    const desired = desiredAccess(start(), 0);
    await syncAccess(desired, cf.store, cf.api, "a");
    await syncLogins(desired, cf.store, cf.api, "a", "example.com", "", false);
    expect(cf.puts[0]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          policies: [
            { id: "machines", precedence: 1 },
            { id: cf.rows.get("policy:owner:login")!.cfId, precedence: 2 },
          ],
        }),
      }),
    );
  });

  it("runs the login step before the sync, inside one budget (K-406)", async () => {
    const order: Array<string> = [];
    const logins = async () => {
      order.push("logins");
      return 8;
    };
    const access = async (budget: number) => {
      order.push(`access ${budget}`);
      return true;
    };
    expect(await syncWithLogins(21, true, logins, access)).toBe(8);
    expect(order).toEqual(["logins", "access 13"]);
    order.length = 0;
    // No room for the whole login step: it waits for the next alarm, and the sync keeps its budget.
    expect(await syncWithLogins(7, true, logins, access)).toBe(0);
    expect(await syncWithLogins(21, false, logins, access)).toBe(0);
    expect(order).toEqual(["access 7", "access 21"]);
  });

  it("leaves /login alone without the machines policy, so service tokens keep their login", async () => {
    const cf = loginCloudflare(undefined, true, false);
    const desired = desiredAccess(start(), 0);
    await syncAccess(desired, cf.store, cf.api, "a");
    await expect(syncLogins(desired, cf.store, cf.api, "a", "example.com", "", false)).rejects.toThrow(
      'no policy "kitshn machines"',
    );
    expect(cf.puts.map((put) => put.path)).toEqual([
      "/accounts/a/access/apps/pages-passkey",
      "/accounts/a/access/apps/files-passkey",
    ]);
  });

  it("never deletes a policy that a login application holds", async () => {
    const cf = fakeCloudflare();
    const state = start();
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const held = loginHeld(loginWant(desiredAccess(state, 0), cf.rows));
    const gone = desiredAccess({ ...state, resources: new Map() }, 0);
    cf.calls.length = 0;
    await syncAccess(gone, cf.store, cf.api, "a", 40, new Set(), held);
    const deleted = cf.calls.filter((call) => call.startsWith("DELETE /policies"));
    for (const id of held) expect(deleted).not.toContain(`DELETE /policies/${id}`);
    expect(hasAccessWork(gone, cf.rows, new Set(), held)).toBe(false);
  });

  it("keeps a policy off the passkey login while Cloudflare holds a body without its passkey check", async () => {
    const cf = fakeCloudflare();
    const desired = desiredAccess(start(), 0);
    await syncAccess(desired, cf.store, cf.api, "a");
    const row = cf.rows.get("policy:owner:login-passkey")!;
    const { mfa_config: _, ...old } = JSON.parse(row.body) as Record<string, unknown>;
    cf.rows.set(row.key, { ...row, body: JSON.stringify(old) });
    expect(JSON.parse(loginWant(desired, cf.rows))).toEqual({
      login: [cf.rows.get("policy:owner:login")!.cfId],
      passkey: [],
    });
  });

  it("warns on the map about a login policy that Cloudflare refused", async () => {
    const cf = fakeCloudflare();
    const desired = desiredAccess(start(), 0);
    const failing: Api = async (method, path, body) => {
      if (method === "POST" && path.endsWith("/policies")) throw new Error("refused");
      return cf.api(method, path, body);
    };
    await syncAccess(desired, cf.store, failing, "a");
    expect(loginWarnings(desired, cf.rows)).toEqual([
      expect.stringContaining('"kitshn circle Owner (login)" of pages and files failed: refused'),
      expect.stringContaining('"kitshn circle Owner (passkey login)" of pages and files failed: refused'),
    ]);
  });

  it("holds only the login copies, so a site policy still changes while the login step waits (K-409)", async () => {
    const cf = fakeCloudflare();
    const state = start();
    await syncAccess(desiredAccess(state, 0), cf.store, cf.api, "a");
    const held = loginHeld(loginWant(desiredAccess(state, 0), cf.rows));
    const people = cf.rows.get("policy:owner:people")!;
    const passkeyCopy = cf.rows.get("policy:owner:login-passkey")!;
    // "Needs passkey" turns off, and the login step was skipped or failed.
    const owner = state.circles.get("owner")!;
    const relaxed = desiredAccess(
      { ...state, circles: new Map(state.circles).set("owner", { ...owner, needsPasskey: false }) },
      0,
    );
    cf.calls.length = 0;
    await syncAccess(relaxed, cf.store, cf.api, "a", 40, new Set(), held);
    expect(cf.calls).toContain(`PUT /policies/${people.cfId}`);
    expect(cf.calls).not.toContain(`DELETE /policies/${passkeyCopy.cfId}`);
    expect(cf.rows.get(passkeyCopy.key)!.body).toBe(passkeyCopy.body);
    // Once the login step lets go of it, the copy goes.
    await syncAccess(relaxed, cf.store, cf.api, "a", 40, new Set(), loginHeld(loginWant(relaxed, cf.rows)));
    expect(cf.calls).toContain(`DELETE /policies/${passkeyCopy.cfId}`);
  });

  it("holds the earlier and the new ids after a login step that failed part way", () => {
    const before = JSON.stringify({ login: ["a"], passkey: ["p"] });
    const want = JSON.stringify({ login: ["a", "b"], passkey: [] });
    expect(JSON.parse(loginHeldAfter(before, want, false))).toEqual({ login: ["a", "b"], passkey: ["p"] });
    expect(loginHeldAfter(before, want, true)).toBe(want);
    expect(loginHeldAfter("", want, false)).toBe(want);
  });
});
