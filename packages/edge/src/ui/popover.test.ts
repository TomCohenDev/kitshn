import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TIP_DELAY_MS, menuMove, placeFloating, tipTimer } from "./popover.ts";

describe("tooltip timing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const track = () => {
    const seen: Array<string | null> = [];
    return { seen, timer: tipTimer<string>((anchor) => seen.push(anchor)) };
  };

  it("shows on hover only after the delay", () => {
    const { seen, timer } = track();
    timer.hover("a");
    vi.advanceTimersByTime(TIP_DELAY_MS - 1);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["a"]);
  });

  it("shows on keyboard focus at once", () => {
    const { seen, timer } = track();
    timer.focus("a");
    expect(seen).toEqual(["a"]);
  });

  it("never shows when the pointer leaves before the delay", () => {
    const { seen, timer } = track();
    timer.hover("a");
    timer.leave("a");
    vi.advanceTimersByTime(TIP_DELAY_MS * 2);
    expect(seen).toEqual([]);
  });

  it("hides on leave, blur and Escape, and ignores the leave of another anchor", () => {
    const { seen, timer } = track();
    timer.focus("a");
    timer.leave("b");
    expect(seen).toEqual(["a"]);
    timer.leave("a");
    timer.focus("b");
    timer.hide();
    expect(seen).toEqual(["a", null, "b", null]);
  });

  it("keeps one pending hover when the pointer moves inside the anchor", () => {
    const { seen, timer } = track();
    timer.hover("a");
    vi.advanceTimersByTime(TIP_DELAY_MS - 50);
    timer.hover("a");
    vi.advanceTimersByTime(50);
    expect(seen).toEqual(["a"]);
  });

  it("switches at once from an open tooltip to the next anchor", () => {
    const { seen, timer } = track();
    timer.focus("a");
    timer.hover("b");
    expect(seen).toEqual(["a", "b"]);
  });
});

describe("floating placement", () => {
  const viewport = { width: 800, height: 600 };
  const size = { width: 200, height: 40 };

  it("puts a tooltip above its anchor, centred", () => {
    const place = placeFloating({ left: 300, top: 300, width: 100, height: 20 }, size, viewport, {
      side: "top",
      align: "center",
    });
    expect(place).toEqual({ side: "top", left: 250, top: 252 });
  });

  it("flips below at the top edge and stays inside the right edge", () => {
    const place = placeFloating({ left: 760, top: 10, width: 30, height: 20 }, size, viewport, {
      side: "top",
      align: "center",
    });
    expect(place.side).toBe("bottom");
    expect(place.top).toBe(38);
    expect(place.left + size.width).toBeLessThanOrEqual(viewport.width);
  });

  it("flips a menu above at the bottom edge", () => {
    const place = placeFloating({ left: 10, top: 590, width: 0, height: 0 }, size, viewport, {
      side: "bottom",
      align: "start",
    });
    expect(place).toEqual({ side: "top", left: 10, top: 542 });
  });
});

describe("menu keys", () => {
  const labels = ["Open", "Share with Qlik", "Stack", "Remove"];

  it("moves with the arrows and wraps", () => {
    expect(menuMove("ArrowDown", -1, labels)).toBe(0);
    expect(menuMove("ArrowDown", 3, labels)).toBe(0);
    expect(menuMove("ArrowUp", 0, labels)).toBe(3);
    expect(menuMove("ArrowUp", -1, labels)).toBe(3);
  });

  it("jumps with Home and End", () => {
    expect(menuMove("Home", 2, labels)).toBe(0);
    expect(menuMove("End", 0, labels)).toBe(3);
  });

  it("jumps to the next item that starts with a typed letter", () => {
    expect(menuMove("s", 0, labels)).toBe(1);
    expect(menuMove("S", 1, labels)).toBe(2);
    expect(menuMove("s", 2, labels)).toBe(1);
    expect(menuMove("x", 0, labels)).toBeNull();
  });

  it("leaves other keys and an empty menu alone", () => {
    expect(menuMove("Enter", 0, labels)).toBeNull();
    expect(menuMove(" ", 0, labels)).toBeNull();
    expect(menuMove("ArrowDown", -1, [])).toBeNull();
  });
});
