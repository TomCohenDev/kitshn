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
    // A sub-list keeps the menu open and starts with Back; Escape goes back to the item it came from.
    expect(focused()).toBe("◂ Back");
    expect(document.activeElement?.hasAttribute("aria-haspopup")).toBe(false);
    await key("Escape");
    expect(focused()).toBe("Share with▸");
    await press();
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

describe("a sub-list inside a sub-list (K-527)", () => {
  it("opens two levels deep, runs the inner action, and Back goes up one level at a time", async () => {
    const nestedRan: Array<string> = [];
    const nested: ActionGroups = [
      [
        {
          id: "unshare",
          label: "Unshare from",
          tip: "Unshare it.",
          items: [
            {
              id: "unshare:owner",
              label: "Owner",
              tip: "Owner.",
              items: [
                { id: "unshare:owner:card", label: "This card", tip: "Card.", run: () => nestedRan.push("card") },
                { id: "unshare:owner:stack", label: "Apps (2)", tip: "Stack.", run: () => nestedRan.push("stack") },
              ],
            },
          ],
        },
      ],
    ];
    const root = document.createElement("div");
    document.body.append(root);
    const anchor = { left: 0, top: 0, width: 0, height: 0 };
    await act(() => render(h(ActionMenu, { label: "Actions for riffle", anchor, groups: nested, onClose: () => undefined }), root));
    expect(focused()).toBe("Unshare from▸");
    await press();
    await key("ArrowDown");
    expect(focused()).toBe("Owner▸");
    await press();
    expect(focused()).toBe("◂ Back");
    await key("ArrowDown");
    expect(focused()).toBe("This card");
    // Escape climbs one level: to Owner in the Unshare list, then to Unshare from at the top.
    await key("Escape");
    expect(focused()).toBe("Owner▸");
    await key("Escape");
    expect(focused()).toBe("Unshare from▸");
    await press();
    await key("ArrowDown");
    await press();
    await key("ArrowDown");
    await press();
    expect(nestedRan).toEqual(["card"]);
    render(null, root);
  });
});
