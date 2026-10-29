import type { ProviderReport } from "@kitshn/local";
import { describe, expect, it } from "vitest";
import type { Machine } from "./machine.ts";
import { type Circle, type Resource, type State, levelForKind, shareKey } from "./model.ts";
import { applyChanges, forgetProviderChanges, invert } from "./changes.ts";
import { commandsFor, grantTables, grantsOf, providerCards, providerPushes } from "./providers.ts";

const report: ProviderReport = {
  name: "t3",
  online: true,
  kinds: [
    { id: "t3.app", name: "T3 app", levels: { view: "view", use: "use", control: "control" } },
    { id: "t3.thread", name: "thread", levels: { view: "view", use: "send" } },
  ],
  commands: [
    { id: "restart", title: "Restart server", kinds: ["t3.app"], confirm: true },
    { id: "stop-agents", title: "Stop all agents", kinds: [], confirm: true },
  ],
  resources: [
    { id: "app", kind: "t3.app", name: "T3", status: "running", site: { name: "t3-vps", port: 3773 } },
    { id: "th-1", kind: "t3.thread", name: "Fix", status: "running", parent: "app", facts: [] },
  ],
};

const machine: Machine = {
  id: "vps",
  name: "vps",
  labels: [],
  order: 0,
  serviceTokenId: "t",
  clientId: "vps.access",
  tunnelId: "u",
};

const circle = (id: string, members: Circle["members"], extra: Partial<Circle> = {}): Circle => ({
  id,
  name: id,
  color: "#000",
  level: "control",
  members,
  match: "any",
  needsPasskey: false,
  endsAt: null,
  x: 0,
  y: 0,
  r: 100,
  ...extra,
});

function state(circles: ReadonlyArray<Circle>, extra: Partial<State> = {}): State {
  const cards = providerCards(machine, [report], "example.com");
  return {
    circles: new Map(circles.map((item) => [item.id, item])),
    resources: cards,
    places: new Map([...cards.keys()].map((id) => [id, { x: 0, y: 0 }])),
    shareSettings: new Map(),
    ends: new Map(),
    stacks: new Map(),
    paused: null,
    machines: new Map([[machine.id, machine]]),
    ...extra,
  };
}

const thread = (value: State) => [...value.resources.values()].find((card) => card.kind === "t3.thread")!;

describe("provider cards (K-705)", () => {
  it("gives a site its address, stacks a child with its parent, and shows an offline provider", () => {
    const cards = [...providerCards(machine, [report], "example.com").values()];
    const [app, child] = cards;
    expect(app).toMatchObject({ addresses: ["t3-vps.example.com"], machine: "vps", status: "running" });
    expect(child?.group).toBe(app?.id);
    const offline = providerCards(machine, [{ ...report, online: false }], "example.com");
    expect([...offline.values()].every((card) => card.status === "offline")).toBe(true);
  });

  it("maps a circle level to the provider's level by K-206 (K-713)", () => {
    const card = thread(state([]));
    expect(levelForKind(card, "control")).toBe("use");
    expect(levelForKind(card, "view")).toBe("view");
  });
});

describe("grant tables (K-706)", () => {
  it("names the provider's level and gives devices and machines their Access client id", () => {
    const value = state([
      circle("her", [
        { _tag: "email", email: "Her@Example.com" },
        { _tag: "machine", machineId: "vps" },
        { _tag: "device", tokenId: "d", clientId: "phone.access", name: "phone" },
      ]),
    ]);
    expect(grantsOf(value, thread(value), 0)).toEqual([
      {
        circle: {
          id: "her",
          name: "her",
          match: "any",
          needsPasskey: false,
          rules: [
            { email: "her@example.com" },
            { machine: { machineId: "vps", clientId: "vps.access" } },
            { device: { clientId: "phone.access", name: "phone" } },
          ],
        },
        level: "send",
        endsAt: null,
      },
    ]);
  });

  it("carries the earlier end date and drops an ended share (K-209)", () => {
    const her = circle("her", [{ _tag: "email", email: "a@b.c" }], { endsAt: 500 });
    const value = state([her]);
    const card = thread(value);
    const withShare = {
      ...value,
      shareSettings: new Map([[shareKey(card.id, "her"), { level: null, endsAt: 200 }]]),
    };
    expect(grantsOf(withShare, card, 0)[0]?.endsAt).toBe(200);
    expect(grantsOf(withShare, card, 300)).toEqual([]);
  });

  it("closes every grant in a pause, and never widens an 'all must match' circle (K-1504, K-006)", () => {
    const mixed = circle("mixed", [
      { _tag: "email", email: "a@b.c" },
      { _tag: "ip", range: "10.0.0.0/8" },
    ]);
    const strict = { ...mixed, id: "strict", match: "all" as const };
    const paused = state([mixed, strict], { paused: "keep-public" });
    // A pause closes every share of a provider card, as for a machine (K-1504).
    expect(grantsOf(paused, thread(paused), 0)).toEqual([]);
    const unknown = circle(
      "unknown",
      [
        { _tag: "email", email: "a@b.c" },
        { _tag: "machine", machineId: "gone" },
      ],
      {
        match: "all",
      },
    );
    const open = state([unknown]);
    expect(grantsOf(open, thread(open), 0)).toEqual([]);
  });

  it("builds one table per resource of the provider, by its own id", () => {
    const value = state([circle("her", [{ _tag: "email", email: "a@b.c" }])]);
    expect(Object.keys(grantTables(value, "vps", "t3", 0)).sort()).toEqual(["app", "th-1"]);
    expect(grantTables(value, "other", "t3", 0)).toEqual({});
  });
});

describe("provider commands (K-707)", () => {
  it("offers a card the commands of its kind, and the machine card the commands without kinds", () => {
    const value = state([]);
    const app = [...value.resources.values()].find((card) => card.kind === "t3.app") as Resource;
    expect(commandsFor([report], app).map((item) => item.command.id)).toEqual(["restart"]);
    expect(commandsFor([report], thread(value))).toEqual([]);
    const machineCard = { kind: "machine" } as const;
    expect(commandsFor([report], machineCard).map((item) => item.command.id)).toEqual(["stop-agents"]);
  });
});

describe("forget provider (K-704)", () => {
  it("removes the provider's cards with their places and overrides, and undo brings them back offline", () => {
    const her = circle("her", [{ _tag: "email", email: "a@b.c" }]);
    const value = state([her]);
    const card = thread(value);
    const withOverride = {
      ...value,
      shareSettings: new Map([[shareKey(card.id, "her"), { level: "view" as const, endsAt: null }]]),
    };
    const changes = forgetProviderChanges(withOverride, "vps", "t3");
    const after = applyChanges(withOverride, changes);
    expect([...after.resources.values()].some((item) => item.provider)).toBe(false);
    expect(after.places.size).toBe(0);
    expect(after.shareSettings.size).toBe(0);
    const undone = applyChanges(after, invert(changes));
    expect(undone.resources.get(card.id)?.status).toBe("offline");
    expect(undone.places.get(card.id)).toEqual(withOverride.places.get(card.id));
    expect(undone.shareSettings.get(shareKey(card.id, "her"))?.level).toBe("view");
  });

  it("gives a dropped card no grants while it waits (K-705)", () => {
    const value = state([circle("her", [{ _tag: "email", email: "a@b.c" }])]);
    const card = thread(value);
    const dropped = { ...card, provider: { ...card.provider!, droppedAt: 1 } };
    const waiting = { ...value, resources: new Map([...value.resources, [card.id, dropped]]) };
    expect(Object.keys(grantTables(waiting, "vps", "t3", 0))).toEqual(["app"]);
  });
});

describe("pushes to a machine (K-709, K-717, K-1608)", () => {
  it("gives each provider its grants and card settings, and each state kind the shared and own part", () => {
    const kinds = [
      {
        id: "t3.app",
        name: "T3 app",
        levels: { view: "view" },
        settings: [
          { id: "updateChannel", title: "Update channel", values: ["nightly", "daily"], default: "nightly" },
        ],
      },
      { id: "t3.settings", name: "settings", levels: {}, state: {} },
    ];
    const withSettings = providerCards(
      machine,
      [{ ...report, kinds: [...kinds, report.kinds[1]!] }],
      "example.com",
    );
    const value: State = { ...state([]), resources: withSettings };
    const app = [...withSettings.values()].find((card) => card.kind === "t3.app")!;
    const desired = new Map([
      [
        "t3.settings",
        new Map<string, unknown>([
          ["", { theme: "dark" }],
          ["other", { x: 1 }],
        ]),
      ],
    ]);
    const pushes = providerPushes(
      value,
      "vps",
      [{ name: "t3", kinds }],
      desired,
      new Map([[app.id, { updateChannel: "daily" }]]),
      0,
    );
    expect(pushes.map((push) => push.key)).toEqual(["grants:t3", "settings:t3", "desired:t3:t3.settings"]);
    expect(pushes[1]).toMatchObject({ values: { app: { updateChannel: "daily" } } });
    // Another machine's part never reaches this one.
    expect(pushes[2]).toMatchObject({ state: { shared: { theme: "dark" }, machine: null } });
    // A stored value that the kind no longer offers falls back to the default.
    const stale = providerPushes(
      value,
      "vps",
      [{ name: "t3", kinds }],
      desired,
      new Map([[app.id, { updateChannel: "weekly" }]]),
      0,
    );
    expect(stale[1]).toMatchObject({ values: { app: { updateChannel: "nightly" } } });
  });
});
