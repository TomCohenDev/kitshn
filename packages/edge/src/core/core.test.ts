import { describe, expect, it } from "vitest";
import { circlePolicies, desiredAccess } from "./access.ts";
import {
  applyChanges,
  conflictOf,
  type Edit,
  invert,
  refuseRaiseWhilePaused,
  refuseResume,
  resolveEdits,
  ruleViolation,
  shareDiff,
  stacksWithout,
  summarize,
  withStackMates,
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
    stacks: new Map(),
    paused: null,
    machines: new Map(),
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
    expect(circleMatches(qlik, { email: "a@qlik.com", clientId: null, ip: "10.1.2.3" }, new Map())).toBe(
      true,
    );
    expect(circleMatches(qlik, { email: "a@qlik.com", clientId: null, ip: "8.8.8.8" }, new Map())).toBe(
      false,
    );
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
    const policies = circlePolicies(circle(start(), OWNER_CIRCLE_ID), new Map());
    expect([...policies.keys()]).toEqual(["policy:owner:people"]);
    const body = policies.get("policy:owner:people")!;
    expect(body.decision).toBe("allow");
    expect(body.include).toEqual([{ email: { email: OWNER } }]);
    expect(body.mfa_config?.allowed_authenticators).toContain("biometrics");
  });

  it("compiles Everyone to a bypass and devices to Service Auth", () => {
    expect(
      circlePolicies(circle(start(), EVERYONE_CIRCLE_ID), new Map()).get("policy:everyone:people")?.decision,
    ).toBe("bypass");
    const devices: Circle = {
      ...circle(start(), "her"),
      members: [
        { _tag: "email", email: "her@example.com" },
        { _tag: "device", tokenId: "t1", clientId: "c1.access", name: "her phone" },
      ],
    };
    const policies = circlePolicies(devices, new Map());
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
    expect(circlePolicies(withToken, new Map()).size).toBe(0);
    const withMachine: Circle = {
      ...withToken,
      members: [withToken.members[0]!, { _tag: "machine", machineId: "m1" }],
    };
    expect(circlePolicies(withMachine, new Map()).size).toBe(0);
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

describe("pause (K-1504)", () => {
  it("closes every share except the Owner circle's share of the admin", () => {
    const state = start();
    const { after } = edit(state, [{ _tag: "pause", after: "lockdown" }]);
    expect(ruleViolation(after)).toBeNull();
    const access = desiredAccess(after, 0);
    expect(access.apps.get("app:riffle:riffle.example.com")?.policyKeys).toEqual([]);
    expect(access.apps.get("app:kitshn-admin:kit.example.com")?.policyKeys).toEqual(["policy:owner:people"]);
    const owner = { email: OWNER, clientId: null, ip: null };
    expect(visitorLevel(after, after.resources.get("riffle")!, owner, 0)).toBeNull();
    expect(visitorLevel(after, after.resources.get(ADMIN_RESOURCE_ID)!, owner, 0)).toBe("control");
  });

  it("stops owner devices during a pause and keeps refusing a public admin", () => {
    const state = start();
    const owner = circle(state, OWNER_CIRCLE_ID);
    const device = { _tag: "device" as const, tokenId: "t1", clientId: "c1.access", name: "agent" };
    const withDevice = edit(state, [
      { _tag: "circle", id: OWNER_CIRCLE_ID, after: { ...owner, members: [...owner.members, device] } },
    ]);
    const paused = edit(withDevice.after, [{ _tag: "pause", after: "lockdown" }]).after;
    const admin = paused.resources.get(ADMIN_RESOURCE_ID)!;
    expect(visitorLevel(paused, admin, { email: null, clientId: "c1.access", ip: null }, 0)).toBeNull();
    expect(desiredAccess(paused, 0).apps.get("app:kitshn-admin:kit.example.com")?.policyKeys).toEqual([
      "policy:owner:people",
    ]);
    const everyone = circle(paused, EVERYONE_CIRCLE_ID);
    const covering = edit(paused, [
      {
        _tag: "circle",
        id: EVERYONE_CIRCLE_ID,
        after: { ...everyone, level: "control", x: 0, y: 40, r: 100 },
      },
    ]);
    expect(ruleViolation(covering.after)).toMatch(/public/);
  });

  it("refuses a pause when only another circle guards the admin", () => {
    const state = start();
    const owner = circle(state, OWNER_CIRCLE_ID);
    const moved = edit(state, [
      { _tag: "circle", id: "admins", after: { ...owner, id: "admins", name: "Admins", x: 2000, y: 2000 } },
      { _tag: "place", id: ADMIN_RESOURCE_ID, after: { x: 2000, y: 2000 } },
    ]);
    expect(ruleViolation(edit(moved.after, [{ _tag: "pause", after: "lockdown" }]).after)).toMatch(/pause/);
  });
});

describe("stacks (K-521, K-522)", () => {
  const stack = { id: "s1", name: "Sites", members: ["kitshn-admin", "riffle"] };
  it("refuses a stack of one card or of a missing card", () => {
    expect(() =>
      edit(start(), [{ _tag: "stack", id: "s1", after: { ...stack, members: ["riffle"] } }]),
    ).toThrow(/at least two/);
    expect(() =>
      edit(start(), [{ _tag: "stack", id: "s1", after: { ...stack, members: ["riffle", "gone"] } }]),
    ).toThrow(/No card/);
  });

  it("keeps a card in one stack, on the point of its stack, and undoes a stack in one step", () => {
    const point = { x: 0, y: 40 };
    const { changes, after } = edit(start(), [
      { _tag: "place", id: "riffle", after: point },
      { _tag: "stack", id: "s1", after: stack },
    ]);
    expect(ruleViolation(after)).toBeNull();
    expect(
      ruleViolation(
        applyChanges(after, [{ _tag: "place", id: "riffle", before: point, after: { x: 9, y: 9 } }]),
      ),
    ).toMatch(/share one place/);
    const second = { id: "s2", name: "Other", members: ["riffle", "kitshn-admin"] };
    expect(
      ruleViolation(applyChanges(after, [{ _tag: "stack", id: "s2", before: null, after: second }])),
    ).toMatch(/two stacks/);
    expect(applyChanges(after, invert(changes)).stacks.size).toBe(0);
  });

  it("moves the whole stack when one of its cards moves, and lets a card leave in the same change", () => {
    const point = { x: 0, y: 40 };
    const { after } = edit(start(), [
      { _tag: "place", id: "riffle", after: point },
      { _tag: "stack", id: "s1", after: stack },
    ]);
    const moved = applyChanges(after, resolveEdits(after, [{ _tag: "place", id: "riffle", after: { x: 5, y: 5 } }]));
    expect(moved.places.get("kitshn-admin")).toEqual({ x: 5, y: 5 });
    expect(ruleViolation(moved) ?? "").not.toMatch(/share one place/);
    const left = applyChanges(
      after,
      resolveEdits(after, [
        ...stacksWithout(after.stacks.values(), "riffle").map((change): Edit => ({ _tag: "stack", ...change })),
        { _tag: "place", id: "riffle", after: { x: 5, y: 5 } },
      ]),
    );
    expect(left.places.get("kitshn-admin")).toEqual(point);
    expect(left.stacks.size).toBe(0);
  });

  it("undoes an older move of a card that joined a stack since then, with its stack", () => {
    const first = edit(start(), [{ _tag: "place", id: "riffle", after: { x: 0, y: 40 } }]);
    const second = edit(first.after, [
      { _tag: "place", id: "kitshn-admin", after: { x: 0, y: 40 } },
      { _tag: "stack", id: "s1", after: stack },
    ]);
    const undone = applyChanges(second.after, withStackMates(second.after, invert(first.changes)));
    expect(ruleViolation(undone) ?? "").not.toMatch(/share one place/);
    expect(undone.places.get("kitshn-admin")).toEqual(undone.places.get("riffle"));
  });

  it("takes a card out of its stack when an undo sends it back to the tray", () => {
    const point = { x: 0, y: 40 };
    const first = edit(start(), [{ _tag: "place", id: "riffle", after: point }]);
    const second = edit(first.after, [
      { _tag: "place", id: "kitshn-admin", after: point },
      { _tag: "stack", id: "s1", after: stack },
    ]);
    const undone = applyChanges(
      second.after,
      withStackMates(second.after, [{ _tag: "place", id: "riffle", before: point, after: null }]),
    );
    expect(undone.places.get("kitshn-admin")).toEqual(point);
    expect(undone.stacks.size).toBe(0);
    expect(ruleViolation(undone) ?? "").not.toMatch(/stack/);
  });

  it("keeps the rules true when a stacked card is deleted outside an edit", () => {
    const point = { x: 0, y: 40 };
    const { after } = edit(start(), [
      { _tag: "place", id: "riffle", after: point },
      { _tag: "stack", id: "s1", after: stack },
    ]);
    const resources = new Map(after.resources);
    const places = new Map(after.places);
    resources.delete("riffle");
    places.delete("riffle");
    const stacks = new Map(after.stacks);
    for (const change of stacksWithout(after.stacks.values(), "riffle")) {
      if (change.after) stacks.set(change.id, change.after);
      else stacks.delete(change.id);
    }
    expect(stacks.size).toBe(0);
    expect(ruleViolation({ ...after, resources, places, stacks })).toBeNull();
  });
});

describe("emergency pause (K-1504)", () => {
  it("lets an edit or an undo pause, but never resume", () => {
    const paused = edit(start(), [{ _tag: "pause", after: "lockdown" }]);
    expect(refuseResume(paused.changes)).toEqual(paused.changes);
    expect(() => refuseResume(resolveEdits(paused.after, [{ _tag: "pause", after: null }]))).toThrow(/passkey/);
    expect(() => refuseResume(invert(paused.changes))).toThrow(/passkey/);
  });
  it("keeps public sites open unless the pause is a lockdown", () => {
    const state = start();
    const everyone = circle(state, EVERYONE_CIRCLE_ID);
    const open = edit(state, [{ _tag: "place", id: "riffle", after: { x: everyone.x, y: everyone.y } }]).after;
    const stranger = { email: null, clientId: null, ip: null };
    const riffle = open.resources.get("riffle")!;
    for (const [mode, level] of [
      ["keep-public", "use"],
      ["lockdown", null],
    ] as const) {
      const paused = edit(open, [{ _tag: "pause", after: mode }]).after;
      expect(visitorLevel(paused, riffle, stranger, 0) === null).toBe(level === null);
      expect(desiredAccess(paused, 0).apps.get("app:riffle:riffle.example.com")?.policyKeys ?? []).toEqual(
        level === null ? [] : [`policy:${EVERYONE_CIRCLE_ID}:people`],
      );
    }
  });
  it("closes public sites during a pause, but reopens them only through Resume", () => {
    const soft = edit(start(), [{ _tag: "pause", after: "keep-public" }]).after;
    const hard = edit(soft, [{ _tag: "pause", after: "lockdown" }]);
    expect(refuseResume(hard.changes)).toEqual(hard.changes);
    expect(() => refuseResume(invert(hard.changes))).toThrow(/passkey/);
  });
  it("lets access only go down while paused (MM-711)", () => {
    const paused = edit(start(), [{ _tag: "pause", after: "lockdown" }]).after;
    const owner = paused.circles.get("owner")!;
    const wider = edit(paused, [
      { _tag: "circle", id: "owner", after: { ...owner, members: [...owner.members, { _tag: "everyone" }] } },
    ]).after;
    expect(() => refuseRaiseWhilePaused(paused, wider)).toThrow(/only goes down/);
    const narrower = edit(paused, [{ _tag: "circle", id: "owner", after: { ...owner, needsPasskey: true } }]).after;
    expect(() => refuseRaiseWhilePaused(paused, narrower)).not.toThrow();
    const allMatch = { ...owner, match: "all" as const, members: [...owner.members, { _tag: "ip" as const, range: "10.0.0.0/8" }] };
    const strict = { ...paused, circles: new Map(paused.circles).set("owner", allMatch) };
    const looser = { ...strict, circles: new Map(strict.circles).set("owner", { ...allMatch, members: owner.members }) };
    expect(() => refuseRaiseWhilePaused(strict, looser)).toThrow(/only goes down/);
    const ending = { ...paused, shareSettings: new Map([["kitshn-admin/owner", { level: null, endsAt: 5 }]]) };
    expect(() => refuseRaiseWhilePaused(ending, { ...ending, shareSettings: new Map() })).toThrow(/end later/);
  });
});
