import { describe, expect, it } from "vitest";
import { desiredAccess } from "../core/access.ts";
import { applyChanges, resolveEdits } from "../core/changes.ts";
import type { State } from "../core/model.ts";
import { seed } from "../core/seed.ts";
import { type AccessRow, type Api, accessStates, hasAccessWork, syncAccess } from "./access-sync.ts";

function start(): State {
  const s = seed(["owner@example.com"], "kit.example.com");
  return {
    circles: new Map(s.circles.map((circle) => [circle.id, circle])),
    resources: new Map(s.resources.map((resource) => [resource.id, resource])),
    places: new Map(s.places),
    shareSettings: new Map(),
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
    expect(cf.calls).toEqual([
      "GET /policies?per_page=1000",
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
    await syncAccess(desiredAccess(withoutAdmin, 0), cf.store, cf.api, "a");
    expect(cf.calls).toEqual(["DELETE /apps/id2", "DELETE /policies/id1"]);
    expect(cf.rows.size).toBe(0);
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
    expect(cf.calls).toEqual(["PUT /policies/id1"]);
  });
});
