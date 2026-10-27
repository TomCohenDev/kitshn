import { describe, expect, it } from "vitest";
import { circlePolicies, desiredAccess } from "./access.ts";
import {
  applyChanges,
  conflictOf,
  type Edit,
  invert,
  resolveEdits,
  ruleViolation,
  shareDiff,
  summarize,
} from "./changes.ts";
import {
  ADMIN_RESOURCE_ID,
  type Circle,
  EVERYONE_CIRCLE_ID,
  OWNER_CIRCLE_ID,
  type Resource,
  type State,
  levelForKind,
  shareKey,
} from "./model.ts";
import { placeInside } from "./place.ts";
import { seed } from "./seed.ts";
import { circleMatches, ipInRange, visitorLevel } from "./visitor.ts";

const OWNER = "owner@example.com";

function start(): State {
  const s = seed([OWNER], "kit.example.com");
  const site: Resource = {
    id: "riffle",
    kind: "site.compose",
    name: "riffle",
    addresses: ["riffle.example.com"],
    status: "running",
    group: null,
    machine: null,
  };
  const her: Circle = {
    id: "her",
    name: "Her",
    color: "#FF5277",
    level: "use",
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
    resources: new Map([...s.resources, site].map((resource) => [resource.id, resource])),
    places: new Map([...s.places, ["riffle", { x: 0, y: -200 }]]),
    shareSettings: new Map(),
  };
}

const edit = (state: State, edits: Array<Edit>) => {
  const changes = resolveEdits(state, edits);
  return { changes, after: applyChanges(state, changes) };
};

const circle = (state: State, id: string) => {
  const found = state.circles.get(id);
  if (!found) throw new Error(`no circle ${id}`);
  return found;
};

describe("levels", () => {
  it("maps a level that the kind lacks to the highest lower level (K-206)", () => {
    expect(levelForKind("file", "control")).toBe("view");
    expect(levelForKind("machine", "use")).toBe("use");
    expect(levelForKind("kitshn.admin", "view")).toBeNull();
  });
});

describe("admin guard (K-105)", () => {
  it("accepts the seeded state", () => {
    expect(ruleViolation(start())).toBeNull();
  });

  it("refuses moving the admin card out of the Owner circle", () => {
    const { after } = edit(start(), [{ _tag: "place", id: ADMIN_RESOURCE_ID, after: { x: 2000, y: 2000 } }]);
    expect(ruleViolation(after)).toMatch(/passkey/);
  });

  it("refuses turning the passkey off or lowering the Owner level", () => {
    const state = start();
    const owner = circle(state, OWNER_CIRCLE_ID);
    for (const changed of [
      { ...owner, needsPasskey: false },
      { ...owner, level: "view" as const },
      { ...owner, members: [] },
    ]) {
      const { after } = edit(state, [{ _tag: "circle", id: OWNER_CIRCLE_ID, after: changed }]);
      expect(ruleViolation(after)).not.toBeNull();
    }
  });

  it("refuses a public admin and a deleted Owner circle", () => {
    const state = start();
    const everyone = circle(state, EVERYONE_CIRCLE_ID);
    const covering = edit(state, [
      {
        _tag: "circle",
        id: EVERYONE_CIRCLE_ID,
        after: { ...everyone, level: "control", x: 0, y: 40, r: 100 },
      },
    ]);
    expect(ruleViolation(covering.after)).toMatch(/public/);
    const deleted = edit(state, [{ _tag: "circle", id: OWNER_CIRCLE_ID, after: null }]);
    expect(ruleViolation(deleted.after)).toMatch(/Owner circle/);
  });

  it("refuses an Owner circle that can never match anyone", () => {
    const state = start();
    const owner = circle(state, OWNER_CIRCLE_ID);
    const { after } = edit(state, [
      {
        _tag: "circle",
        id: OWNER_CIRCLE_ID,
        after: {
          ...owner,
          match: "all",
          members: [...owner.members, { _tag: "email", email: "b@example.com" }],
        },
      },
    ]);
    expect(ruleViolation(after)).toMatch(/passkey/);
    const otherDomain = edit(state, [
      {
        _tag: "circle",
        id: OWNER_CIRCLE_ID,
        after: {
          ...owner,
          match: "all",
          members: [...owner.members, { _tag: "domain", domain: "other.com" }],
        },
      },
    ]);
    expect(ruleViolation(otherDomain.after)).toMatch(/passkey/);
  });

  it("accepts a second passkey circle that takes over the admin", () => {
    const state = start();
    const owner = circle(state, OWNER_CIRCLE_ID);
    const { after } = edit(state, [
      {
        _tag: "circle",
        id: "admins",
        after: { ...owner, id: "admins", name: "Admins", x: 2000, y: 2000 },
      },
      { _tag: "place", id: ADMIN_RESOURCE_ID, after: { x: 2000, y: 2000 } },
    ]);
    expect(ruleViolation(after)).toBeNull();
  });
});

describe("changes and undo (K-1501, K-1502)", () => {
  it("drops edits that change nothing", () => {
    const state = start();
    expect(resolveEdits(state, [{ _tag: "place", id: "riffle", after: { x: 0, y: -200 } }])).toEqual([]);
  });

  it("undoes a change and refuses an undo after a later change", () => {
    const state = start();
    const first = edit(state, [{ _tag: "place", id: "riffle", after: { x: 400, y: 0 } }]);
    const undo = invert(first.changes);
    expect(conflictOf(first.after, undo)).toBeNull();
    expect(applyChanges(first.after, undo).places.get("riffle")).toEqual({ x: 0, y: -200 });

    const second = edit(first.after, [{ _tag: "place", id: "riffle", after: { x: 900, y: 900 } }]);
    expect(conflictOf(second.after, undo)).toBe('place "riffle"');
  });

  it("names share changes in the summary (K-502, K-503)", () => {
    const state = start();
    const { changes, after } = edit(state, [{ _tag: "place", id: "riffle", after: { x: 400, y: 0 } }]);
    const diffs = shareDiff(state, after);
    expect(diffs.map((diff) => [diff.circle.id, diff.from, diff.to])).toEqual([
      ["owner", "view", null],
      ["her", null, "view"],
    ]);
    expect(summarize(state, after, changes)).toBe("riffle: − Owner; riffle: + Her · view");
  });

  it("uses a share override over the circle default (K-205)", () => {
    const state = start();
    const { after } = edit(state, [
      { _tag: "shareSetting", resourceId: "riffle", circleId: "owner", after: { level: null, endsAt: 5 } },
    ]);
    expect(after.shareSettings.get(shareKey("riffle", "owner"))).toEqual({ level: null, endsAt: 5 });
  });

  it("refuses an edit of a card that does not exist", () => {
    expect(() => resolveEdits(start(), [{ _tag: "place", id: "nope", after: { x: 0, y: 0 } }])).toThrow(
      /No card/,
    );
  });
});

describe("placement (K-511)", () => {
  it("finds a point inside exactly the wanted circles", () => {
    const state = start();
    const point = placeInside(state, { x: 0, y: -200 }, new Set(["owner", "her"]));
    expect(point).not.toBeNull();
    const placed = applyChanges(state, resolveEdits(state, [{ _tag: "place", id: "riffle", after: point }]));
    expect(shareDiff(state, placed).map((diff) => diff.circle.id)).toEqual(["her"]);
  });

  it("returns null when the circles do not overlap", () => {
    expect(placeInside(start(), { x: 0, y: 0 }, new Set(["owner", "everyone"]))).toBeNull();
  });
});

describe("visitors (K-203, K-207)", () => {
  it("matches IPv4 and IPv6 ranges", () => {
    expect(ipInRange("10.0.0.7", "10.0.0.0/24")).toBe(true);
    expect(ipInRange("10.0.1.7", "10.0.0.0/24")).toBe(false);
    expect(ipInRange("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(ipInRange("2001:db9::1", "2001:db8::/32")).toBe(false);
    expect(ipInRange("10.0.0.7", "2001:db8::/32")).toBe(false);
  });

  it("needs every member in an all circle", () => {
    const qlik: Circle = {
      ...circle(start(), "her"),
      match: "all",
      members: [
        { _tag: "domain", domain: "qlik.com" },
        { _tag: "ip", range: "10.0.0.0/8" },
      ],
    };
    expect(circleMatches(qlik, { email: "a@qlik.com", clientId: null, ip: "10.1.2.3" })).toBe(true);
    expect(circleMatches(qlik, { email: "a@qlik.com", clientId: null, ip: "8.8.8.8" })).toBe(false);
  });

  it("gives the owner control of the admin and nobody else", () => {
    const state = start();
    const admin = state.resources.get(ADMIN_RESOURCE_ID)!;
    expect(visitorLevel(state, admin, { email: "OWNER@example.com", clientId: null, ip: null }, 0)).toBe(
      "control",
    );
    expect(visitorLevel(state, admin, { email: "her@example.com", clientId: null, ip: null }, 0)).toBeNull();
  });

  it("ignores a share after its end date", () => {
    const state = start();
    const { after } = edit(state, [
      { _tag: "shareSetting", resourceId: "riffle", circleId: "owner", after: { level: null, endsAt: 10 } },
    ]);
    const riffle = after.resources.get("riffle")!;
    const owner = { email: OWNER, clientId: null, ip: null };
    expect(visitorLevel(after, riffle, owner, 9)).toBe("view");
    expect(visitorLevel(after, riffle, owner, 10)).toBeNull();
  });
});

describe("Access compile (K-401 to K-403)", () => {
  it("compiles the Owner circle to one allow policy with the passkey check", () => {
    const policies = circlePolicies(circle(start(), OWNER_CIRCLE_ID));
    expect([...policies.keys()]).toEqual(["policy:owner:people"]);
    const body = policies.get("policy:owner:people")!;
    expect(body.decision).toBe("allow");
    expect(body.include).toEqual([{ email: { email: OWNER } }]);
    expect(body.mfa_config?.allowed_authenticators).toContain("biometrics");
  });

  it("compiles Everyone to a bypass and devices to Service Auth", () => {
    expect(circlePolicies(circle(start(), EVERYONE_CIRCLE_ID)).get("policy:everyone:people")?.decision).toBe(
      "bypass",
    );
    const devices: Circle = {
      ...circle(start(), "her"),
      members: [
        { _tag: "email", email: "her@example.com" },
        { _tag: "device", tokenId: "t1", clientId: "c1.access", name: "her phone" },
      ],
    };
    const policies = circlePolicies(devices);
    expect(policies.get("policy:her:tokens")?.decision).toBe("non_identity");
    expect(policies.get("policy:her:people")?.mfa_config).toBeUndefined();
  });

  it("gives an all circle no policy when a member cannot become a require rule (K-006)", () => {
    const base = circle(start(), "her");
    const withToken: Circle = {
      ...base,
      match: "all",
      members: [
        { _tag: "email", email: "her@example.com" },
        { _tag: "device", tokenId: "t1", clientId: "c1.access", name: "her phone" },
      ],
    };
    expect(circlePolicies(withToken).size).toBe(0);
    const withMachine: Circle = {
      ...withToken,
      members: [withToken.members[0]!, { _tag: "machine", machineId: "m1" }],
    };
    expect(circlePolicies(withMachine).size).toBe(0);
  });

  it("gives each addressed card an application with the policies of its circles", () => {
    const state = start();
    const access = desiredAccess(state, 0);
    expect(access.apps.get("app:kitshn-admin:kit.example.com")?.policyKeys).toEqual(["policy:owner:people"]);
    expect(access.apps.get("app:riffle:riffle.example.com")?.policyKeys).toEqual(["policy:owner:people"]);
    const moved = applyChanges(
      state,
      resolveEdits(state, [{ _tag: "place", id: "riffle", after: { x: 3000, y: 3000 } }]),
    );
    expect(desiredAccess(moved, 0).apps.get("app:riffle:riffle.example.com")?.policyKeys).toEqual([]);
  });
});
