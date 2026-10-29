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
  const registry = new Providers({ providers: [], pushed: {} }, (saved) => saves.push(saved.providers));
  return { registry, saves };
}

describe("the providers of a machine (K-704, K-705)", () => {
  it("lets only the registering connection change a provider, and a new register takes it over", () => {
    const { registry } = providers();
    expect(registry.apply(register([thread("a")]), 1, new Set())).toEqual({ ok: true, changed: true });
    const upsert = { id: "2", type: "upsert", provider: "t3", resources: [thread("b")] } as const;
    expect(registry.apply(upsert, 2, new Set())).toMatchObject({ ok: false, error: /register t3/ });
    expect(registry.apply(upsert, 1, new Set())).toEqual({ ok: true, changed: true });
    expect(registry.apply({ id: "3", type: "remove", provider: "t3", ids: ["a"] }, 1, new Set())).toEqual({
      ok: true,
      changed: true,
    });
    expect(registry.reports()[0]?.resources.map((resource) => resource.id)).toEqual(["b"]);
    registry.apply(register([]), 2, new Set());
    expect(registry.connectionOf("t3")).toBe(2);
    expect(registry.reports()[0]?.resources).toEqual([]);
  });

  it("refuses a change that breaks the rules and keeps the last good state", () => {
    const { registry } = providers();
    registry.apply(register([thread("a")]), 1, new Set());
    const bad = {
      id: "2",
      type: "upsert",
      provider: "t3",
      resources: [{ ...thread("x"), parent: "nope" }],
    } as const;
    expect(registry.apply(bad, 1, new Set())).toMatchObject({ ok: false, error: /unknown parent/ });
    expect(registry.reports()[0]?.resources.map((resource) => resource.id)).toEqual(["a"]);
  });

  it("takes a provider offline when its connection closes, and saves it offline", () => {
    const { registry, saves } = providers();
    registry.apply(register([thread("a")]), 7, new Set());
    expect(saves.at(-1)?.[0]?.online).toBe(false);
    expect(registry.disconnect(7)).toBe(true);
    expect(registry.reports()[0]).toMatchObject({ name: "t3", online: false });
    expect(registry.connectionOf("t3")).toBeNull();
    expect(registry.disconnect(7)).toBe(false);
  });

  it("serves its sites from localhost ports and stores grant tables only when they change (K-706)", () => {
    const { registry } = providers();
    const app = { ...thread("a"), site: { name: "t3-vps", port: 3773 } };
    registry.apply({ ...register([]), resources: [app] }, 1, new Set());
    expect(registry.sites()).toEqual([{ name: "t3-vps", target: "http://localhost:3773", dev: false }]);
    expect(registry.setPushed(pushKey.grants("t3"), { a: [] })).toBe(true);
    expect(registry.setPushed(pushKey.grants("t3"), { a: [] })).toBe(false);
    registry.setPushed(pushKey.desired("t3", "t3.settings"), { shared: { theme: "dark" }, machine: null });
    // K-1608: the answer to register gives the saved state, from before kitshn answers.
    expect(registry.savedFor("t3")).toEqual({
      grants: { a: [] },
      desired: { "t3.settings": { shared: { theme: "dark" }, machine: null } },
      settings: {},
    });
  });

  it("forgets only a provider that no connection holds (K-704)", () => {
    const { registry, saves } = providers();
    registry.apply(register([thread("a")]), 1, new Set());
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
