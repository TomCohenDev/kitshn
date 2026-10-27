import { describe, expect, it } from "vitest";
import { desiredAccess } from "../core/access.ts";
import { applyChanges, resolveEdits } from "../core/changes.ts";
import type { State } from "../core/model.ts";
import { seed } from "../core/seed.ts";
import {
  type AccessRow,
  type Api,
  accessStates,
  fillAudiences,
  hasAccessWork,
  rowsWithoutAud,
  signOutEverywhere,
  syncAccess,
  syncLauncher,
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
    paused: false,
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
    return (path.includes("/apps") ? { id, aud: `aud-${id}` } : { id }) as T;
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
    // The Owner policy and the passkey enrollment policy (K-113), then the admin application.
    expect(cf.calls).toEqual([
      "GET /policies?per_page=1000",
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
    await syncAccess(desiredAccess(withoutAdmin, 0), cf.store, cf.api, "a");
    expect(cf.calls).toEqual([`DELETE /apps/${appId}`, `DELETE /policies/${ownerId}`]);
    // The Owner circle still needs a passkey, so its people keep the enrollment policy (K-113).
    expect([...cf.rows.keys()]).toEqual(["policy:enrollment"]);
  });

  it("keeps the audience tag of each application (K-603)", async () => {
    const cf = fakeCloudflare();
    await syncAccess(desiredAccess(start(), 0), cf.store, cf.api, "a");
    const app = cf.rows.get("app:kitshn-admin:kit.example.com")!;
    expect(app.aud).toBe(`aud-${app.cfId}`);
    expect(cf.rows.get("policy:owner:people")!.aud).toBe("");
  });

  it("reads missing audience tags from one list of the applications, by id (K-603)", async () => {
    const cf = fakeCloudflare({
      apps: [
        { id: "app-1", name: "kitshn a", aud: "aud-1" },
        { id: "app-2", name: "kitshn b", aud: "aud-2" },
      ],
    });
    const row = (key: string, cfId: string, aud: string): AccessRow => ({
      key,
      cfId,
      aud,
      body: "{}",
      tried: "",
      error: null,
    });
    // Rows from before the audience tag column, as a deploy finds them.
    cf.store.put(row("app:x:x.example.com", "app-1", ""));
    cf.store.put(row("app:y:y.example.com", "app-gone", ""));
    cf.store.put(row("app:z:z.example.com", "app-2", "aud-2"));
    expect(await fillAudiences(cf.store, cf.api, "a")).toBe(1);
    expect(cf.calls).toEqual(["GET /apps?per_page=1000&page=1"]);
    expect(cf.rows.get("app:x:x.example.com")!.aud).toBe("aud-1");
    expect(rowsWithoutAud(cf.rows).map((item) => item.key)).toEqual(["app:y:y.example.com"]);

    cf.store.put(row("app:y:y.example.com", "", ""));
    cf.calls.length = 0;
    expect(await fillAudiences(cf.store, cf.api, "a")).toBe(0);
    expect(cf.calls).toEqual([]);
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
    await syncAccess(desired, cf.store, cf.api, "a", 40, reachable);
    expect(cf.calls.filter((call) => call.startsWith("DELETE"))).toEqual([]);
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
    const paused = { ...state, paused: true, circles: new Map(state.circles).set("guests", guests) };
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
