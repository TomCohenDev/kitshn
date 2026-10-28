import { describe, expect, it } from "vitest";
import {
  ADMIN_RESOURCE_ID,
  type Circle,
  EVERYONE_CIRCLE_ID,
  OWNER_CIRCLE_ID,
  type Resource,
  type State,
  shareKey,
} from "../core/model.ts";
import type { MachineView } from "../core/protocol.ts";
import { seed } from "../core/seed.ts";
import {
  type Action,
  type ActionContext,
  type ActionGroups,
  type ActionHandlers,
  actionsFor,
  flatten,
  levelEdit,
  paletteActive,
  paletteArrow,
  paletteEnter,
  paletteEntries,
} from "./actions.ts";

/** K-523: the action list per item kind. The menu and the palette both read these lists. */

const card = (id: string, kind: Resource["kind"], addresses: Array<string> = []): Resource => ({
  id,
  kind,
  name: id,
  addresses,
  status: "running",
  group: null,
  machine: null,
});

const her: Circle = {
  id: "her",
  name: "Her",
  color: "#FF5277",
  level: "use",
  members: [{ _tag: "email", email: "her@example.com" }],
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x: -400,
  y: 0,
  r: 200,
};

function context(version = "0123456789ab"): ActionContext {
  const s = seed(["owner@example.com"], "kit.example.com");
  const resources = [
    ...s.resources,
    card("riffle", "site.compose", ["riffle.example.com"]),
    card("vps", "machine"),
    card("notes", "page", ["pages.example.com/notes"]),
    card("a", "file"),
    card("b", "file"),
    card("loose", "file"),
  ];
  const state: State = {
    // Everyone overlaps Owner, so a card fits into both; Her overlaps Owner on the other side.
    circles: new Map(
      [...s.circles.map((circle) => (circle.id === EVERYONE_CIRCLE_ID ? { ...circle, x: 500 } : circle)), her].map(
        (circle) => [circle.id, circle],
      ),
    ),
    resources: new Map(resources.map((resource) => [resource.id, resource])),
    places: new Map([
      ...s.places,
      ["riffle", { x: 0, y: -200 }],
      ["vps", { x: 10, y: 10 }],
      ["a", { x: -500, y: 0 }],
      ["b", { x: -500, y: 0 }],
    ]),
    shareSettings: new Map(),
    stacks: new Map([["s1", { id: "s1", name: "Docs", members: ["a", "b"] }]]),
    paused: null,
    machines: new Map(),
  };
  const machine: MachineView = {
    machine: { id: "vps", name: "vps", labels: [], order: 0, serviceTokenId: "t", clientId: "c", tunnelId: "u" },
    online: true,
    lastSeen: null,
    status: null,
    sample: null,
    keyFailure: null,
    orphanVolumes: [],
  };
  return {
    state,
    deployed: new Set(["riffle"]),
    machines: new Map([["vps", machine]]),
    version,
    undoItems: { "card:riffle": null, "circle:her": "#9 \"Moved b\" changed the same cards or circles later." },
  };
}

/** Handlers that record each call by name. */
function recorder() {
  const calls: Array<[string, ...Array<unknown>]> = [];
  const handlers = new Proxy({} as ActionHandlers, {
    get: (_target, name) => (...args: Array<unknown>) => calls.push([String(name), ...args]),
  });
  return { calls, handlers };
}

const ids = (groups: ActionGroups | null) => (groups ?? []).flat().map((action) => action.id);
const find = (groups: ActionGroups | null, id: string): Action => {
  const action = (groups ?? []).flat().find((candidate) => candidate.id === id);
  if (!action) throw new Error(`No action ${id} in ${ids(groups).join(", ")}`);
  return action;
};
const run = (action: Action) => {
  if (!("run" in action)) throw new Error(`${action.id} opens a list`);
  action.run();
};
const items = (action: Action) => ("items" in action ? action.items : []);

describe("card actions", () => {
  it("offers a deployed app its address, shares, tray and Remove app, and nothing of a machine", () => {
    const { handlers, calls } = recorder();
    const groups = actionsFor(context(), handlers, { _tag: "card", id: "riffle" });
    expect(ids(groups)).toEqual([
      "details",
      "open",
      "copy",
      "share",
      "unshare",
      "select-kind",
      "add-to-stack",
      "tray",
      "undo-item",
      "remove-app",
    ]);
    expect(find(groups, "remove-app").danger).toBe(true);
    // The card sits in the Owner circle only, so it can join Everyone and Her.
    expect(items(find(groups, "share")).map((item) => item.id)).toEqual([`share:${EVERYONE_CIRCLE_ID}`, "share:her"]);
    run(find(groups, "remove-app"));
    run(items(find(groups, "share"))[1] as Action);
    expect(calls.map(([name]) => name)).toEqual(["removeApp", "reshare"]);
    expect(calls[1]).toMatchObject(["reshare", { id: "riffle" }, { id: "her" }, true]);
  });

  it("gives a machine its level per circle and its daemon commands, and Update only with a release", () => {
    const { handlers, calls } = recorder();
    const groups = actionsFor(context(), handlers, { _tag: "card", id: "vps" });
    expect(ids(groups)).toEqual(
      expect.arrayContaining([`level:${OWNER_CIRCLE_ID}`, "restart", "update", "remove-machine"]),
    );
    expect(ids(groups)).not.toContain("remove-app");
    expect(items(find(groups, `level:${OWNER_CIRCLE_ID}`)).map((item) => item.id)).toEqual([
      `level:${OWNER_CIRCLE_ID}:default`,
      `level:${OWNER_CIRCLE_ID}:view`,
      `level:${OWNER_CIRCLE_ID}:use`,
      `level:${OWNER_CIRCLE_ID}:control`,
    ]);
    run(find(groups, "update"));
    expect(calls[0]).toMatchObject(["runJob", { machine: { id: "vps" } }, { kind: "update", version: "0123456789ab" }]);
    expect(ids(actionsFor(context("local"), handlers, { _tag: "card", id: "vps" }))).not.toContain("update");
  });

  it("has no level list for a kind with one level, no tray for the admin, and Place for a tray card", () => {
    const { handlers } = recorder();
    const ctx = context();
    expect(ids(actionsFor(ctx, handlers, { _tag: "card", id: "riffle" })).some((id) => id.startsWith("level:"))).toBe(false);
    expect(ids(actionsFor(ctx, handlers, { _tag: "card", id: ADMIN_RESOURCE_ID }))).not.toContain("tray");
    const loose = ids(actionsFor(ctx, handlers, { _tag: "card", id: "loose" }));
    expect(loose).toContain("place");
    expect(loose).not.toContain("tray");
    expect(loose).not.toContain("share");
  });

  it("lets a stacked card leave its stack, and not join it again", () => {
    const { handlers, calls } = recorder();
    const groups = actionsFor(context(), handlers, { _tag: "card", id: "a" });
    expect(ids(groups)).toContain("leave-stack");
    expect(ids(groups)).not.toContain("add-to-stack");
    run(find(groups, "leave-stack"));
    expect(calls[0]).toEqual(["pullOut", "s1", "a"]);
  });

  it("selects every placed card of the same kind", () => {
    const { handlers, calls } = recorder();
    run(find(actionsFor(context(), handlers, { _tag: "card", id: "a" }), "select-kind"));
    expect(calls[0]).toEqual(["select", { cards: new Set(["a", "b"]), circle: null }]);
  });
});

describe("stack, circle and map actions", () => {
  it("lists each card of a stack under Pull out", () => {
    const { handlers } = recorder();
    const groups = actionsFor(context(), handlers, { _tag: "stack", id: "s1" });
    expect(ids(groups)).toEqual(expect.arrayContaining(["details", "rename", "pull-out", "unstack"]));
    expect(items(find(groups, "pull-out")).map((item) => item.id)).toEqual(["pull-out:a", "pull-out:b"]);
  });

  it("never offers to delete the Owner circle (K-211), and deletes another at once", () => {
    const { handlers, calls } = recorder();
    expect(ids(actionsFor(context(), handlers, { _tag: "circle", id: OWNER_CIRCLE_ID }))).not.toContain("delete");
    const groups = actionsFor(context(), handlers, { _tag: "circle", id: "her" });
    expect(find(groups, "delete").danger).toBe(true);
    run(find(groups, "delete"));
    expect(calls[0]).toMatchObject(["deleteCircle", { id: "her" }]);
  });

  it("adds a circle and an upload at the clicked point", () => {
    const { handlers, calls } = recorder();
    const groups = actionsFor(context(), handlers, { _tag: "map", at: { x: 5, y: 6 } });
    run(find(groups, "new-circle"));
    run(find(groups, "upload"));
    expect(calls).toEqual([
      ["newCircle", { x: 5, y: 6 }],
      ["upload", { x: 5, y: 6 }],
    ]);
  });

  it("has no menu for an item that is gone", () => {
    expect(actionsFor(context(), recorder().handlers, { _tag: "card", id: "gone" })).toBeNull();
  });
});

describe("the palette", () => {
  it("has every action of every menu, so no action exists only in a menu", () => {
    const { handlers } = recorder();
    const ctx = context();
    const palette = new Set(paletteEntries(ctx, handlers).map((entry) => entry.label));
    for (const id of ctx.state.resources.keys()) {
      const groups = actionsFor(ctx, handlers, { _tag: "card", id });
      // flatten leaves out refused actions, in the menu and in the palette alike.
      for (const entry of flatten(groups ?? [], "")) expect([...palette].some((label) => label.endsWith(entry.label))).toBe(true);
    }
    // K-511: the words of "Share <card> with <circle>" find the entry.
    expect([...palette].filter((label) => ["share", "riffle", "her"].every((word) => label.toLowerCase().includes(word)))).toEqual([
      "📦 riffle · Share with: Her",
    ]);
  });
});

describe("refused actions", () => {
  it("shows an action that the rules refuse as refused, and leaves it out of the palette", () => {
    const { handlers, calls } = recorder();
    const ctx = context();
    // K-105: the admin card stays in the Owner circle, so the menu says why before anything is sent.
    const unshare = items(find(actionsFor(ctx, handlers, { _tag: "card", id: ADMIN_RESOURCE_ID }), "unshare"));
    expect(unshare.find((item) => item.id === `unshare:${OWNER_CIRCLE_ID}`)?.refused).toMatch(/admin/);
    expect(paletteEntries(ctx, handlers).map((entry) => entry.label)).not.toContain("🔐 kitshn admin · Unshare from: Owner");
    // A card in Everyone only cannot also be in Her: the two circles do not overlap.
    const loose = { ...ctx, state: { ...ctx.state, places: new Map([...ctx.state.places, ["loose", { x: 700, y: 0 }]]) } };
    const share = items(find(actionsFor(loose, handlers, { _tag: "card", id: "loose" }), "share"));
    expect(share.find((item) => item.id === "share:her")?.refused).toMatch(/No spot/);
    expect(calls).toEqual([]);
  });

  it("shows Add to stack refused when the stack's circles break a rule (K-105)", () => {
    const ctx = context();
    // The stack lies outside every circle, so the admin card that joins it would leave the Owner circle.
    const state: State = {
      ...ctx.state,
      places: new Map([...ctx.state.places, ["a", { x: 5000, y: 0 }], ["b", { x: 5000, y: 0 }]]),
    };
    const groups = actionsFor({ ...ctx, state }, recorder().handlers, { _tag: "card", id: ADMIN_RESOURCE_ID });
    expect(items(find(groups, "add-to-stack")).find((item) => item.id === "add-to-stack:s1")?.refused).toMatch(/admin/);
  });

  it("marks the current level as the checked radio item", () => {
    const groups = actionsFor(context(), recorder().handlers, { _tag: "card", id: "vps" });
    const levels = items(find(groups, `level:${OWNER_CIRCLE_ID}`));
    expect(levels.filter((item) => item.checked).map((item) => item.id)).toEqual([`level:${OWNER_CIRCLE_ID}:default`]);
  });
});

describe("Enter in the palette", () => {
  const safe = {};
  const danger = { danger: true as const };
  it("never runs a dangerous top match from Enter alone while other entries match", () => {
    expect(paletteEnter([danger, safe], 0, false)).toBeNull();
    expect(paletteEnter([danger, safe], 0, true)).toBe(0);
    expect(paletteEnter([danger], 0, false)).toBe(0);
    expect(paletteEnter([safe, danger], 0, false)).toBe(0);
    expect(paletteEnter([], 0, false)).toBeNull();
  });

  it("keeps the active entry by label, so a reorder never changes what Enter runs", () => {
    const moved = paletteArrow("ArrowDown", ["a", "Remove b"], { label: null, picked: false });
    expect(moved).toEqual({ label: "Remove b", picked: true });
    // A broadcast puts another entry first: the cursor stays on "Remove b".
    expect(paletteActive(["c", "a", "Remove b"], moved)).toEqual({ index: 2, picked: true });
    // The entry is gone: the first match is active and not picked.
    expect(paletteActive(["c", "a"], moved)).toEqual({ index: 0, picked: false });
  });

  it("does not pick on an arrow that does not move, nor on a hover", () => {
    const top = { label: "Remove a", picked: false };
    expect(paletteArrow("ArrowUp", ["Remove a", "b"], top)).toBe(top);
    expect(paletteArrow("ArrowDown", ["Remove a"], top)).toBe(top);
    // A hover sets the label with picked false, so Enter alone still refuses a dangerous entry.
    const hovered = paletteActive(["b", "Remove a"], { label: "Remove a", picked: false });
    expect(paletteEnter([{}, { danger: true }], hovered.index, hovered.picked)).toBeNull();
  });

  it("finds an action by the words of its older label", () => {
    const entries = paletteEntries(context(), recorder().handlers);
    expect(entries.find((entry) => entry.label === "Add a machine")?.keywords).toContain("join");
    expect(entries.find((entry) => entry.label === "Add a site")?.keywords).toContain("static");
  });
});

describe("levelEdit (K-205)", () => {
  it("clears the setting for the default, and keeps an end date", () => {
    const ctx = context();
    const vps = ctx.state.resources.get("vps") as Resource;
    const owner = ctx.state.circles.get(OWNER_CIRCLE_ID) as Circle;
    expect(levelEdit(ctx.state, vps, owner, null).after).toBeNull();
    const ending: State = { ...ctx.state, shareSettings: new Map([[shareKey("vps", OWNER_CIRCLE_ID), { level: "use", endsAt: 9 }]]) };
    expect(levelEdit(ending, vps, owner, null).after).toEqual({ level: null, endsAt: 9 });
    expect(levelEdit(ending, vps, owner, "view").after).toEqual({ level: "view", endsAt: 9 });
  });
});

describe("per-item undo (K-1507)", () => {
  it("runs when kitshn allows it, and shows the reason when it refuses or no change of the caller exists", () => {
    const { handlers, calls } = recorder();
    const card = find(actionsFor(context(), handlers, { _tag: "card", id: "riffle" }), "undo-item");
    expect(card.refused).toBeUndefined();
    run(card);
    expect(calls).toEqual([["undoItem", { kind: "card", id: "riffle" }]]);
    const circle = find(actionsFor(context(), handlers, { _tag: "circle", id: "her" }), "undo-item");
    expect(circle.refused).toMatch(/changed the same cards or circles later/);
    const none = find(actionsFor(context(), handlers, { _tag: "card", id: "vps" }), "undo-item");
    expect(none.refused).toBe("You have no recent change to this card to undo.");
  });
});
