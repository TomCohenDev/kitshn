// @vitest-environment happy-dom
import { Fragment, h, render } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { describe, expect, it } from "vitest";
import type { ActionGroups } from "./actions.ts";
import { ActionMenu, MoreButton } from "./controls.tsx";
import type { Rect } from "./popover.ts";

/** K-523: the "⋯" button is the keyboard path to a context menu. */

const ran: Array<string> = [];
const groups: ActionGroups = [
  [
    { id: "details", label: "Show details", tip: "Show it.", run: () => ran.push("details") },
    {
      id: "share",
      label: "Share with",
      tip: "Share it.",
      items: [{ id: "share:her", label: "Her", tip: "Share with Her.", run: () => ran.push("share:her") }],
    },
  ],
];

function Harness() {
  const [anchor, setAnchor] = useState<Rect | null>(null);
  return h(
    Fragment,
    null,
    h(MoreButton, { name: "riffle", onOpen: setAnchor }),
    anchor ? h(ActionMenu, { label: "Actions for riffle", anchor, groups, onClose: () => setAnchor(null) }) : null,
  );
}

const key = (key: string) =>
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
/** What a browser does for Enter or Space on a focused button. */
const press = () =>
  act(() => {
    (document.activeElement as HTMLElement).click();
  });
const focused = () => document.activeElement?.textContent;

describe("the ⋯ menu from the keyboard", () => {
  it("opens on the focused button, moves with the arrows, opens a sub-list and gives the focus back", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    await act(() => render(h(Harness, null), root));
    const button = root.querySelector<HTMLButtonElement>('button[aria-label="Actions for riffle"]');
    if (!button) throw new Error("No ⋯ button");
    expect(button.tabIndex).toBe(0);
    expect(button.getAttribute("aria-haspopup")).toBe("menu");

    button.focus();
    await press();
    expect(document.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("Actions for riffle");
    expect(focused()).toBe("Show details");

    await key("ArrowDown");
    expect(focused()).toBe("Share with▸");
    await press();
    // A sub-list keeps the menu open and starts with Back.
    expect(focused()).toBe("◂ Share with");
    await key("ArrowDown");
    await press();
    expect(ran).toEqual(["share:her"]);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);

    await press();
    await key("Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(button);
    render(null, root);
  });
});
