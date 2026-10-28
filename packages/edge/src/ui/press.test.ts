import { describe, expect, it } from "vitest";
import { SLOP_PX, startPress, stepPress } from "./press.ts";

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
