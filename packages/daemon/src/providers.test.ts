import type { ProviderReport, ProviderRequest } from "@kitshn/local";
import { describe, expect, it } from "vitest";
import { Providers, parseSaved } from "./providers.ts";
import { pushKey } from "@kitshn/local";

const kinds = [{ id: "t3.thread", name: "thread", levels: { view: "view", use: "send" } }] as const;
const thread = (id: string) => ({ id, kind: "t3.thread", name: id, status: "running" }) as const;
const register = (
  resources: ReadonlyArray<ReturnType<typeof thread>>,
): ProviderRequest & { type: "register" } => ({
  id: "1",
  type: "register",
  provider: "t3",
  kinds: [...kinds],
  commands: [],
  resources: [...resources],
});

function providers() {
  const saves: Array<ReadonlyArray<ProviderReport>> = [];
  let statusChanges = 0;
  const registry = new Providers(
    { providers: [], pushed: {} },
    (saved) => saves.push(saved.providers),
    () => statusChanges++,
  );
  return { registry, saves, statusChanges: () => statusChanges };
}

describe("the providers of a machine (K-704, K-705)", () => {
  it("binds a provider name to the user that registered it, refuses another user, and moves it with rebind (K-704)", () => {
    let saved: unknown = null;
    const registry = new Providers(
      { providers: [], pushed: {} },
      (value) => (saved = value),
      () => {},
    );
    const cards = register([thread("a"), thread("b")]);
    expect(registry.apply(cards, 1, new Set(), 0, true)).toEqual({ ok: true, changed: true });
    // Another user cannot take the name over, with a reason that names the way.
    expect(registry.apply(cards, 2, new Set(), 1002, false)).toMatchObject({
      ok: false,
      error: /belongs to the user id 0.*providers rebind t3 --to-user/,
    });
    expect(registry.rebind("t3", 1002)).toBeNull();
    // The old connection is offline, so its upserts need a register, which the bind now refuses.
    expect(
      registry.apply({ id: "2", type: "upsert", provider: "t3", resources: [] }, 1, new Set(), 0, true),
    ).toMatchObject({
      ok: false,
    });
    expect(registry.apply(cards, 3, new Set(), 0, true)).toMatchObject({
      ok: false,
      error: /belongs to the user id 1002/,
    });
    // The new user registers the same cards: the same ids, so kitshn keeps their circles and grants.
    expect(registry.apply(cards, 4, new Set(), 1002, false)).toEqual({ ok: true, changed: false });
    expect(registry.reports()[0]?.resources.map((item) => item.id)).toEqual(["a", "b"]);
    // The bind survives a restart.
    const restarted = new Providers(
      parseSaved(saved).saved,
      () => {},
      () => {},
    );
    expect(restarted.ownerOf("t3")).toBe(1002);
    expect(registry.rebind("other", 1002)).toMatch(/no provider other/);
    // A refused takeover leaves the running provider as it is: no "provider refused" for its owner.
    expect(registry.refused()).toEqual([]);
  });

  it("lets only root or the daemon user claim a provider saved before providers had users (K-704)", () => {
    const old = new Providers(
      parseSaved({
        providers: [{ name: "t3", online: false, kinds: [...kinds], commands: [], resources: [thread("a")] }],
        pushed: {},
      }).saved,
      () => {},
      () => {},
    );
    expect(old.apply(register([thread("a")]), 1, new Set(), 1002, false)).toMatchObject({
      ok: false,
      error: /saved before providers had users/,
    });
    expect(old.ownerOf("t3")).toBeUndefined();
    expect(old.apply(register([thread("a")]), 2, new Set(), 0, true)).toMatchObject({ ok: true });
    expect(old.ownerOf("t3")).toBe(0);
    // A new name binds to the provider user that registers it first.
    expect(
      old.apply(
        { ...register([]), provider: "fresh", kinds: [{ ...kinds[0], id: "fresh.thread" }] },
        3,
        new Set(),
        1002,
        false,
      ),
    ).toMatchObject({ ok: true });
    expect(old.ownerOf("fresh")).toBe(1002);
  });

  it("lets only the registering connection change a provider, and a new register takes it over", () => {
    const { registry } = providers();
    expect(registry.apply(register([thread("a")]), 1, new Set(), 1000, true)).toEqual({
      ok: true,
      changed: true,
    });
    const upsert = { id: "2", type: "upsert", provider: "t3", resources: [thread("b")] } as const;
    expect(registry.apply(upsert, 2, new Set(), 1000, true)).toMatchObject({
      ok: false,
      error: /register t3/,
    });
    expect(registry.apply(upsert, 1, new Set(), 1000, true)).toEqual({ ok: true, changed: true });
    expect(
      registry.apply({ id: "3", type: "remove", provider: "t3", ids: ["a"] }, 1, new Set(), 1000, true),
    ).toEqual({
      ok: true,
      changed: true,
    });
    expect(registry.reports()[0]?.resources.map((resource) => resource.id)).toEqual(["b"]);
    registry.apply(register([]), 2, new Set(), 1000, true);
    expect(registry.connectionOf("t3")).toBe(2);
    expect(registry.reports()[0]?.resources).toEqual([]);
  });

  it("refuses a change that breaks the rules and keeps the last good state", () => {
    const { registry } = providers();
    registry.apply(register([thread("a")]), 1, new Set(), 1000, true);
    const bad = {
      id: "2",
      type: "upsert",
      provider: "t3",
      resources: [{ ...thread("x"), parent: "nope" }],
    } as const;
    expect(registry.apply(bad, 1, new Set(), 1000, true)).toMatchObject({
      ok: false,
      error: /unknown parent/,
    });
    expect(registry.reports()[0]?.resources.map((resource) => resource.id)).toEqual(["a"]);
  });

  it("keeps the last refused register for the machine status until one is accepted (K-704)", () => {
    const { registry, statusChanges } = providers();
    const bad = register([thread("a"), thread("a")]);
    expect(registry.apply(bad, 1, new Set(), 1000, true)).toMatchObject({ ok: false });
    const [first] = registry.refused();
    expect(first).toMatchObject({ provider: "t3", reason: "t3: two resources have the same id." });
    // A retry with the same reason keeps the start of the refusal and sends no new status.
    registry.apply(bad, 1, new Set(), 1000, true);
    expect(registry.refused()).toEqual([first]);
    expect(statusChanges()).toBe(1);
    expect(registry.apply(register([thread("a")]), 1, new Set(), 1000, true)).toEqual({
      ok: true,
      changed: true,
    });
    expect(registry.refused()).toEqual([]);
    expect(statusChanges()).toBe(2);
  });

  it("takes a provider offline when its connection closes, and saves it offline", () => {
    const { registry, saves } = providers();
    registry.apply(register([thread("a")]), 7, new Set(), 1000, true);
    expect(saves.at(-1)?.[0]?.online).toBe(false);
    expect(registry.disconnect(7)).toBe(true);
    expect(registry.reports()[0]).toMatchObject({ name: "t3", online: false });
    expect(registry.connectionOf("t3")).toBeNull();
    expect(registry.disconnect(7)).toBe(false);
  });

  it("serves its sites from localhost ports and stores grant tables only when they change (K-706)", () => {
    const { registry } = providers();
    const app = { ...thread("a"), site: { name: "t3-vps", port: 3773 } };
    registry.apply({ ...register([]), resources: [app] }, 1, new Set(), 1000, true);
    expect(registry.sites()).toEqual([{ name: "t3-vps", target: "http://localhost:3773", dev: false }]);
    expect(registry.setPushed(pushKey.grants("t3"), { a: [] })).toBe(true);
    expect(registry.setPushed(pushKey.grants("t3"), { a: [] })).toBe(false);
    registry.setPushed(pushKey.desired("t3", "t3.settings"), { shared: { theme: "dark" }, machine: null });
    // K-1608: the answer to register gives the saved state, from before kitshn answers; access is null until kitshn
    // sends it (K-1623).
    expect(registry.savedFor("t3")).toMatchObject({ access: null });
    const access = { teamDomain: "team.cloudflareaccess.com", audiences: ["aud-app"], served: [] };
    registry.setPushed(pushKey.access("t3"), access);
    expect(registry.savedFor("t3")).toEqual({
      grants: { a: [] },
      desired: { "t3.settings": { shared: { theme: "dark" }, machine: null } },
      settings: {},
      reach: [],
      access,
    });
  });

  it("forgets only a provider that no connection holds (K-704)", () => {
    const { registry, saves } = providers();
    registry.apply(register([thread("a")]), 1, new Set(), 1000, true);
    expect(registry.forget("t3")).toMatch(/connected/);
    registry.disconnect(1);
    expect(registry.forget("t3")).toBeNull();
    expect(registry.reports()).toEqual([]);
    expect(saves.at(-1)).toEqual([]);
    expect(registry.forget("t3")).toMatch(/no provider/);
  });

  it("starts empty from a broken file and says why (K-006)", () => {
    expect(parseSaved({ providers: [{ name: "site" }] }).problem).not.toBeNull();
    expect(parseSaved(null)).toEqual({ saved: { providers: [], pushed: {} }, problem: null });
  });
});
