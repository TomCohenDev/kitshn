// @vitest-environment happy-dom
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { describe, expect, it } from "vitest";
import { ResizeEdge } from "./controls.tsx";

/** K-525: the drag edge owns Escape only while a drag runs. */

const limits = { min: 160, max: 420, initial: 210 };

function mount(width: number, commits: Array<number>) {
  const root = document.createElement("div");
  document.body.append(root);
  const edge = (w: number) =>
    h(ResizeEdge, {
      label: "Shelf width",
      width: w,
      limits,
      grows: "right",
      cssVar: "--test-width",
      fit: (x: number) => x,
      onCommit: (x: number) => commits.push(x),
    });
  act(() => render(edge(width), root));
  const element = root.querySelector<HTMLElement>(".resize-edge");
  if (!element) throw new Error("no edge");
  return { root, element, rerender: (w: number) => act(() => render(edge(w), root)) };
}

const pointer = (element: HTMLElement, type: string, clientX: number, buttons = 1) =>
  act(() => {
    element.dispatchEvent(
      new PointerEvent(type, { bubbles: true, clientX, button: 0, buttons, pointerId: 1 }),
    );
  });

/** Presses Escape on the page and says whether a later listener of the page still got it. */
function escapeReachesPage() {
  let reached = false;
  const later = (event: KeyboardEvent) => {
    if (event.key === "Escape") reached = true;
  };
  addEventListener("keydown", later);
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  removeEventListener("keydown", later);
  return reached;
}

describe("resize edge (K-525)", () => {
  it("gives Escape back to the page after a drag that saw a re-render", () => {
    const commits: Array<number> = [];
    const { root, element, rerender } = mount(210, commits);
    pointer(element, "pointerdown", 100);
    pointer(element, "pointermove", 150);
    rerender(210);
    pointer(element, "pointerup", 150, 0);
    expect(commits).toEqual([260]);
    expect(escapeReachesPage()).toBe(true);
    render(null, root);
  });

  it("puts the start width back on Escape during a drag, and keeps that Escape from the page", () => {
    const commits: Array<number> = [];
    const { root, element } = mount(210, commits);
    pointer(element, "pointerdown", 100);
    pointer(element, "pointermove", 180);
    expect(document.documentElement.style.getPropertyValue("--test-width")).toBe("290px");
    expect(escapeReachesPage()).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--test-width")).toBe("210px");
    expect(commits).toEqual([]);
    expect(escapeReachesPage()).toBe(true);
    render(null, root);
  });

  it("drops its listener when it unmounts during a drag", () => {
    const { root, element } = mount(210, []);
    pointer(element, "pointerdown", 100);
    act(() => render(null, root));
    expect(escapeReachesPage()).toBe(true);
  });
});
