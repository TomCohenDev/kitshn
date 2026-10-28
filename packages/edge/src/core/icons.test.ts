import { describe, expect, it } from "vitest";
import { cardIcon, iconAccess, machineOs, repoOwner } from "./icons.ts";
import type { Circle, Resource, State } from "./model.ts";
import { seed } from "./seed.ts";

const OWNER = "owner@example.com";

const card = (id: string, kind: Resource["kind"], name = id): Resource => ({
  id,
  kind,
  name,
  addresses: [],
  status: "running",
  group: null,
  machine: null,
});

/** The seeded state, and a site in the circle "Her", whose member can open the site but not the map. */
function start(): State {
  const s = seed([OWNER], "kit.example.com");
  const her: Circle = {
    id: "her",
    name: "Her",
    color: "#FF5277",
    level: "view",
    members: [{ _tag: "email", email: "her@example.com" }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 400,
    y: 0,
    r: 200,
  };
  return {
    circles: new Map([...s.circles, her].map((circle) => [circle.id, circle])),
    resources: new Map([...s.resources, card("site", "site.static")].map((resource) => [resource.id, resource])),
    places: new Map([...s.places, ["site", { x: 400, y: 0 }]]),
    shareSettings: new Map(),
    stacks: new Map(),
    paused: null,
    machines: new Map(),
  };
}

const person = (email: string) => ({ email, clientId: null, ip: null });

describe("icon route access (K-1113)", () => {
  it("gives the icon only to a visitor who opens the map", () => {
    const state = start();
    const site = state.resources.get("site");
    expect(iconAccess(state, person(OWNER), site, true, 0)).toBe("allow");
    // Her opens the site itself, but not the map, so she does not get the card icon.
    expect(iconAccess(state, person("her@example.com"), site, true, 0)).toBe("deny");
    expect(iconAccess(state, person("stranger@example.com"), site, true, 0)).toBe("deny");
  });

  it("answers missing to the owner for a card without an icon or an unknown card", () => {
    const state = start();
    expect(iconAccess(state, person(OWNER), state.resources.get("site"), false, 0)).toBe("missing");
    expect(iconAccess(state, person(OWNER), undefined, false, 0)).toBe("missing");
  });

  it("denies a stranger also for an unknown card, so the answer says nothing about which cards exist", () => {
    expect(iconAccess(start(), person("stranger@example.com"), undefined, false, 0)).toBe("deny");
  });
});

describe("card icon (K-524)", () => {
  it("shows the stored site icon, versioned by its hash", () => {
    expect(cardIcon(card("a b", "site.static"), { "a b": "f00d" }, null)).toEqual({
      _tag: "site",
      src: "/api/icons/a%20b?v=f00d",
    });
  });

  it("falls back to the kind icon without an own icon", () => {
    expect(cardIcon(card("site", "site.static"), {}, null)).toEqual({ _tag: "kind" });
    expect(cardIcon(card("mac", "machine"), {}, null)).toEqual({ _tag: "kind" });
    expect(cardIcon(card("r", "repo", "not a repo name"), {}, null)).toEqual({ _tag: "kind" });
    // Part 2 gives these kinds their own icons; until then a stored icon of such a card stays unused.
    expect(cardIcon(card("app", "site.compose"), { app: "f00d" }, "linux")).toEqual({ _tag: "kind" });
  });

  it("shows the owner avatar of a repo and the system of a machine", () => {
    expect(cardIcon(card("r", "repo", "Yarden-zamir/kitshn"), {}, null)).toMatchObject({
      _tag: "avatar",
      owner: "Yarden-zamir",
      src: "https://github.com/Yarden-zamir.png?size=64",
    });
    expect(cardIcon(card("mac", "machine"), {}, "macos")).toEqual({ _tag: "os", os: "macos" });
  });

  it("reads the system from the daemon status, and has none for an unknown or missing one", () => {
    expect(machineOs("darwin 25.6.0")).toBe("macos");
    expect(machineOs("linux 6.8.0-1015-oracle")).toBe("linux");
    expect(machineOs("win32 10.0.26100")).toBe("windows");
    expect(machineOs("freebsd 14.1")).toBeNull();
    // A daemon without `os` sends nothing; the Worker reads it as the text "undefined".
    expect(machineOs("undefined")).toBeNull();
  });

  it("reads the owner of a repo name only in the form owner/name", () => {
    expect(repoOwner("Yarden-zamir/kitshn")).toBe("Yarden-zamir");
    expect(repoOwner("kitshn")).toBeNull();
    expect(repoOwner("a/b/c")).toBeNull();
    expect(repoOwner("-bad/x")).toBeNull();
    expect(repoOwner("../x")).toBeNull();
  });
});
