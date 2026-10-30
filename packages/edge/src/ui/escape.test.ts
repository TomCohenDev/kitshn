// @vitest-environment happy-dom
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { describe, expect, it, vi } from "vitest";
import { useDialogEscape } from "./controls.tsx";

/** Escape belongs to the newest dialog wherever the focus is, so it never reaches what lies behind. */
function Dialog(props: { onEscape: () => void }) {
  useDialogEscape(props.onEscape);
  return null;
}

const press = () =>
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

describe("useDialogEscape", () => {
  it("closes the newest dialog only, and keeps Escape from the panel behind", () => {
    const root = document.createElement("div");
    const behind = vi.fn();
    addEventListener("keydown", behind);
    const [first, second] = [vi.fn(), vi.fn()];
    try {
      act(() =>
        render(h("div", null, h(Dialog, { onEscape: first }), h(Dialog, { onEscape: second })), root),
      );
      press();
      expect(second).toHaveBeenCalledOnce();
      expect(first).not.toHaveBeenCalled();
      expect(behind).not.toHaveBeenCalled();
      act(() => render(null, root));
      press();
      expect(behind).toHaveBeenCalledOnce();
    } finally {
      removeEventListener("keydown", behind);
      render(null, root);
    }
  });
});
