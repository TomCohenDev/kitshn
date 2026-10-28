// @vitest-environment happy-dom
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { describe, expect, it } from "vitest";
import type { PaletteEntry } from "./actions.ts";
import { Palette } from "./Palette.tsx";

/** K-511, K-523: the palette takes the focus, and Enter runs only what is highlighted and safe. */

function open(entries: ReadonlyArray<PaletteEntry>) {
  const root = document.createElement("div");
  document.body.append(root);
  // Something else has the focus when the palette opens, as the panel heading does in the app.
  const before = document.createElement("button");
  document.body.append(before);
  before.focus();
  act(() => render(h(Palette, { initialQuery: "", onClose: () => undefined, entries }), root));
  const input = root.querySelector<HTMLInputElement>('input[aria-label="Find"]');
  if (!input) throw new Error("no input");
  return { root, input };
}

/** Types the query and presses Enter in the same task, before any render, as a fast typist or a script does. */
function typeThenEnter(input: HTMLInputElement, query: string) {
  act(() => {
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

describe("command palette", () => {
  it("takes the focus when it opens, so typing goes into the query", () => {
    const { root, input } = open([]);
    expect(document.activeElement).toBe(input);
    render(null, root);
  });

  it("runs the entry that the query highlights when Enter follows the typing at once", () => {
    const ran: Array<string> = [];
    const { root, input } = open([
      { label: "riffle · Remove app", tip: "Remove it.", danger: true, run: () => ran.push("remove") },
      { label: "riffle · Show details", tip: "Show it.", run: () => ran.push("details") },
    ]);
    typeThenEnter(input, "riffle show details");
    expect(ran).toEqual(["details"]);
    render(null, root);
  });

  it("runs a dangerous entry on Enter only when it is the only match", () => {
    const ran: Array<string> = [];
    const entries = [
      { label: "riffle · Remove app", tip: "Remove it.", danger: true as const, run: () => ran.push("remove") },
      { label: "riffle · Show details", tip: "Show it.", run: () => ran.push("details") },
    ];
    const both = open(entries);
    // "riffle" matches both, and the dangerous one comes first: Enter alone runs nothing.
    typeThenEnter(both.input, "riffle");
    expect(ran).toEqual([]);
    render(null, both.root);
    const only = open(entries);
    typeThenEnter(only.input, "riffle remove");
    expect(ran).toEqual(["remove"]);
    render(null, only.root);
  });

});
