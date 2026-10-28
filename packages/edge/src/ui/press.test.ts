import { describe, expect, it } from "vitest";
import { SLOP_PX, fingerDown, startPress, stepPress } from "./press.ts";

/** K-516, K-523: a long press opens the context menu; a move pans before it and drags after it. */
describe("a press that can open the context menu", () => {
  const start = { x: 100, y: 100 };
  const near = { x: 100 + SLOP_PX, y: 100 };
  const far = { x: 100 + SLOP_PX + 1, y: 100 };

  it("opens the menu once the hold time passes, also after a small shake", () => {
    const shaken = stepPress(startPress(start), { type: "move", at: near });
    expect(shaken.phase).toBe("waiting");
    expect(stepPress(shaken, { type: "elapsed" }).phase).toBe("held");
  });

  it("never opens the menu after a move past the slop: that press pans", () => {
    const moved = stepPress(startPress(start), { type: "move", at: far });
    expect(moved.phase).toBe("moved");
    expect(stepPress(moved, { type: "elapsed" }).phase).toBe("moved");
  });

  it("measures the slop from the start, not from the last move", () => {
    const steps = [near, { x: 100 + SLOP_PX, y: 100 + SLOP_PX }].reduce(
      (press, at) => stepPress(press, { type: "move", at }),
      startPress(start),
    );
    expect(steps.phase).toBe("moved");
  });

  it("closes the menu when a held press moves, so the drag goes on", () => {
    const held = stepPress(startPress(start), { type: "elapsed" });
    expect(stepPress(held, { type: "move", at: near }).phase).toBe("held");
    expect(stepPress(held, { type: "move", at: far }).phase).toBe("moved");
  });
});

describe("fingers on the map (K-516)", () => {
  it("makes a pinch of the second finger", () => {
    const fingers = new Map<number, { x: number; y: number }>();
    expect(fingerDown(fingers, 1, { x: 0, y: 0 }, true)).toBeNull();
    expect(fingerDown(fingers, 2, { x: 10, y: 0 }, false)).toEqual({ a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });
  });
  it("forgets a finger whose release never came when a new gesture starts", () => {
    const fingers = new Map<number, { x: number; y: number }>();
    fingerDown(fingers, 1, { x: 0, y: 0 }, true);
    // The page lost finger 1; the next touch is a new primary one, so it is one finger, not a pinch.
    expect(fingerDown(fingers, 7, { x: 50, y: 50 }, true)).toBeNull();
    expect([...fingers.keys()]).toEqual([7]);
  });
});
