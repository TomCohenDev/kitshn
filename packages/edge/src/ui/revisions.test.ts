import { describe, expect, it } from "vitest";
import type { Actor } from "../core/changes.ts";
import type { RevisionView } from "../core/protocol.ts";
import { filterHistory, groupHistory, sentence, undoStates } from "./revisions.ts";

const me: Actor = { _tag: "person", email: "me@example.com" };
const bot: Actor = { _tag: "device", clientId: "c1", name: "Bot" };

const NOW = new Date(2026, 9, 28, 15, 0).getTime();
const HOUR = 60 * 60 * 1000;

const revision = (id: number, at: number, actor: Actor, summary = "Moved a card"): RevisionView => ({
  id,
  at,
  actor,
  summary,
  undoes: null,
  undoneBy: null,
  undoable: true,
  kind: "card",
  items: [{ kind: "card", id: "tick3d" }],
});

describe("History sentences (K-1508)", () => {
  it.each([
    ["tick3d: + Everyone · view", "You shared tick3d with Everyone at view"],
    ["tick3d: − Her", "You removed tick3d from Her"],
    ["a: + Qlik · use; b: − Her", "You shared a with Qlik at use and removed b from Her"],
    [
      "a: + X · view; b: + X · view; c: + X · view; and 2 more",
      "You shared a with X at view, shared b with X at view, shared c with X at view and 2 more",
    ],
    ["Created circle Agents", "You created circle Agents"],
    ["Undo #12: tick3d: − Her", "You undid #12: removed tick3d from Her"],
    ["Undo #12 for tick3d: Moved a card", "You undid #12 for tick3d: moved a card"],
  ])("says %s as a sentence", (summary, said) => {
    expect(sentence({ actor: me, summary }, me)).toBe(said);
  });

  it("keeps a summary of an unknown shape as it is, so it adds no fact", () => {
    expect(sentence({ actor: bot, summary: "Sign out everywhere: kitshn refuses older logins" }, me)).toBe(
      "📱 Bot: Sign out everywhere: kitshn refuses older logins",
    );
  });
});

describe("History groups (K-1508)", () => {
  it("groups by day, then by runs of one actor, newest first", () => {
    const yesterday = NOW - 20 * HOUR;
    const groups = groupHistory(
      [
        revision(5, NOW - HOUR, me),
        revision(4, NOW - 2 * HOUR, me),
        revision(3, NOW - 3 * HOUR, bot),
        revision(2, yesterday, bot),
        revision(1, NOW - 30 * 24 * HOUR, me),
      ],
      NOW,
    );
    expect(groups.map((group) => [group.day, group.actor, group.revisions.map((item) => item.id)])).toEqual([
      ["Today", me, [5, 4]],
      ["Today", bot, [3]],
      ["Yesterday", bot, [2]],
      ["Older", me, [1]],
    ]);
  });

  it("filters by kind, actor and the name of a changed item", () => {
    const revisions = [
      revision(3, NOW, me),
      { ...revision(2, NOW, bot), kind: "circle" as const, items: [{ kind: "circle" as const, id: "c-1" }] },
      revision(1, NOW, bot),
    ];
    const names = (item: { readonly id: string }) => (item.id === "c-1" ? "Agents" : "tick3d");
    const ids = (filter: Parameters<typeof filterHistory>[1]) =>
      filterHistory(revisions, filter, names).map((item) => item.id);
    expect(ids({ kind: "circle", actor: null, item: "" })).toEqual([2]);
    expect(ids({ kind: null, actor: "device:c1", item: "" })).toEqual([2, 1]);
    expect(ids({ kind: null, actor: null, item: "agen" })).toEqual([2]);
  });
});

describe("History Undo per row (K-1506)", () => {
  it("allows only the caller's own newest change and gives every other row a reason", () => {
    const revisions = [
      revision(4, NOW, bot),
      { ...revision(3, NOW, me), undoable: false },
      revision(2, NOW, me),
      revision(1, NOW, me),
    ];
    const undo = undoStates(revisions, me);
    expect(revisions.map((item) => undo(item).allowed)).toEqual([false, false, true, false]);
    expect(undo(revisions[3] as RevisionView)).toEqual({
      allowed: false,
      reason: "Only your newest change can be undone: #2.",
    });
  });
});
