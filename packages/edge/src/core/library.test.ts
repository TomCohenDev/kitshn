import { describe, expect, it } from "vitest";
import { type ContentVisitor, contentAccess, fileNameError } from "./library.ts";
import type { Circle, Resource, State } from "./model.ts";
import { seed } from "./seed.ts";

const OWNER = "owner@example.com";

function start(): State {
  const s = seed([OWNER], "kit.example.com");
  const page: Resource = {
    id: "p",
    kind: "page",
    name: "A page",
    addresses: ["pages.example.com/p"],
    status: "running",
    group: null,
    machine: null,
  };
  const friends: Circle = {
    ...s.circles[0]!,
    id: "friends",
    name: "Friends",
    members: [{ _tag: "email", email: "friend@example.com" }],
    needsPasskey: false,
    x: 2000,
    y: 0,
    r: 100,
  };
  return {
    circles: new Map([...s.circles, friends].map((circle) => [circle.id, circle])),
    resources: new Map([...s.resources, page].map((resource) => [resource.id, resource])),
    places: new Map(s.places),
    shareSettings: new Map(),
    paused: false,
    machines: new Map(),
  };
}

const anonymous: ContentVisitor = { email: null, clientId: null, ip: "203.0.113.9", passkey: false };
const person = (email: string, passkey = false): ContentVisitor => ({
  email,
  clientId: null,
  ip: null,
  passkey,
});
const at = (state: State, x: number) => ({ ...state, places: new Map(state.places).set("p", { x, y: 0 }) });
const decide = (state: State, visitor: ContentVisitor) =>
  contentAccess(state, state.resources.get("p")!, visitor, 0);

describe("page and file access (K-1004)", () => {
  it("serves a page in Everyone with no login", () => {
    expect(decide(at(start(), 760), anonymous)).toBe("allow");
  });

  it("sends an anonymous visitor of a private or shared page to the login", () => {
    expect(decide(start(), anonymous)).toBe("login");
    expect(decide(at(start(), 2000), anonymous)).toBe("login");
  });

  it("lets a circle member in, and refuses a logged-in stranger", () => {
    const shared = at(start(), 2000);
    expect(decide(shared, person("friend@example.com"))).toBe("allow");
    expect(decide(shared, person("stranger@example.com"))).toBe("deny");
  });

  it("opens a private page for the admin only after the passkey login (K-103, K-1002)", () => {
    expect(decide(start(), person(OWNER))).toBe("passkey");
    expect(decide(start(), person(OWNER, true))).toBe("allow");
    expect(decide(start(), person("friend@example.com", true))).toBe("deny");
  });

  it("lets only people through during a pause (K-1504)", () => {
    const paused = { ...at(start(), 2000), paused: true };
    expect(decide(paused, person("friend@example.com"))).toBe("deny");
    expect(decide(paused, person(OWNER, true))).toBe("allow");
  });
});

describe("file names (K-1102)", () => {
  it("takes a normal name and refuses names that leave the path segment", () => {
    expect(fileNameError("report v2.pdf")).toBeNull();
    for (const name of ["", ".", "..", "a/b", "a\\b", "a\nb"]) expect(fileNameError(name)).not.toBeNull();
  });
});
