import { type ComponentChildren, createPortal } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { type Rect, type Side, menuMove, placeFloating, tipTimer } from "./popover.ts";

/**
 * The tick3d standard components (the neo-brutalism skill). An element gets a tooltip with a `data-tip`
 * attribute; one `TooltipLayer` at the root shows it, so no element needs a wrapper.
 */

const TIP_ID = "kitshn-tip";
const viewport = () => ({ width: innerWidth, height: innerHeight });

/** A label describes its control, so a screen reader reads the tooltip with the focused input. */
const describedOf = (anchor: HTMLElement) => (anchor instanceof HTMLLabelElement ? (anchor.control ?? anchor) : anchor);

const anchorOf = (target: EventTarget | null) =>
  target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null;

/** Below for the toolbar, so a tooltip never covers its own row; beside for menu and list items; above elsewhere. */
const sideOf = (anchor: HTMLElement): Side =>
  anchor.closest("header") ? "bottom" : anchor.closest('[role="menu"], [role="listbox"]') ? "right" : "top";

/** Shows the `data-tip` of the hovered or focused element in a portal, so no parent `overflow` clips it. */
export function TooltipLayer() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  // Bumps when the open anchor's `data-tip` changes, so the text and its place follow.
  const [, setRevision] = useState(0);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useMemo(() => tipTimer<HTMLElement>(setAnchor), []);

  useEffect(() => {
    // Focus after a press or a tap is not keyboard focus: a clicked text field shows no tooltip.
    let viaPointer = false;
    const over = (event: PointerEvent) => {
      // Touch has no hover; needed information never lives only in a tooltip.
      if (event.pointerType === "touch") return;
      const next = anchorOf(event.target);
      if (next) timer.hover(next);
      else timer.leave(null);
    };
    const out = (event: PointerEvent) => {
      const from = anchorOf(event.target);
      if (from && !from.contains(event.relatedTarget as Node | null)) timer.leave(from);
    };
    const focus = (event: FocusEvent) => {
      const next = anchorOf(event.target);
      if (next && !viaPointer) timer.focus(next);
      else timer.hide();
    };
    const blur = (event: FocusEvent) => {
      const from = anchorOf(event.target);
      if (from) timer.leave(from);
    };
    const key = (event: KeyboardEvent) => {
      viaPointer = false;
      if (event.key === "Escape") timer.hide();
    };
    const press = () => {
      viaPointer = true;
      timer.hide();
    };
    const events = [
      ["pointerover", over],
      ["pointerout", out],
      ["focusin", focus],
      ["focusout", blur],
      ["keydown", key],
      ["pointerdown", press],
      ["input", timer.hide],
      ["wheel", timer.hide],
      ["scroll", timer.hide],
      ["resize", timer.hide],
    ] as const;
    for (const [name, handler] of events) addEventListener(name, handler as EventListener, { capture: true, passive: true });
    return () => {
      for (const [name, handler] of events) removeEventListener(name, handler as EventListener, true);
    };
  }, []);

  useEffect(() => {
    if (!anchor) return;
    const watch = new MutationObserver(() => setRevision((revision) => revision + 1));
    watch.observe(anchor, { attributes: true, attributeFilter: ["data-tip"] });
    return () => watch.disconnect();
  }, [anchor]);

  const text = anchor?.isConnected ? anchor.dataset["tip"] : undefined;

  useLayoutEffect(() => {
    const element = tip.current;
    if (!anchor || !element) return;
    const described = describedOf(anchor);
    const before = described.getAttribute("aria-describedby");
    described.setAttribute("aria-describedby", before ? `${before} ${TIP_ID}` : TIP_ID);
    // Measure at the corner, so the last place near an edge does not squeeze the new text.
    element.style.left = "0px";
    element.style.top = "0px";
    const place = placeFloating(anchor.getBoundingClientRect(), element.getBoundingClientRect(), viewport(), {
      side: sideOf(anchor),
      align: "center",
    });
    element.style.left = `${place.left}px`;
    element.style.top = `${place.top}px`;
    element.style.visibility = "visible";
    return () => {
      if (before === null) described.removeAttribute("aria-describedby");
      else described.setAttribute("aria-describedby", before);
    };
  }, [anchor, text]);

  if (!text) return null;
  return createPortal(
    <div id={TIP_ID} ref={tip} role="tooltip" class="tooltip" style={{ visibility: "hidden" }}>
      {text}
    </div>,
    document.body,
  );
}

interface ChoiceProps {
  readonly checked: boolean;
  readonly label: ComponentChildren;
  /** One sentence: what the control is and what happens. */
  readonly tip: string;
  readonly disabled?: boolean;
}

/** A checkbox: the native input for keyboard and screen readers, in the tick3d look. */
export function Check(props: ChoiceProps & { readonly onChange: (checked: boolean) => void }) {
  return (
    <label class="choice" data-tip={props.tip}>
      <input
        type="checkbox"
        class="check"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      {props.label}
    </label>
  );
}

/** A switch: a checkbox with `role="switch"`, for a setting that takes effect at once. */
export function Switch(props: ChoiceProps & { readonly onChange: (checked: boolean) => void }) {
  return (
    <label class="choice" data-tip={props.tip}>
      <input
        type="checkbox"
        role="switch"
        class="switch"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      {props.label}
    </label>
  );
}

/** One option of a group; radios with the same `name` move with the arrow keys. */
export function Radio(props: ChoiceProps & { readonly name: string; readonly onSelect: () => void }) {
  return (
    <label class="choice" data-tip={props.tip}>
      <input
        type="radio"
        class="radio"
        name={props.name}
        checked={props.checked}
        disabled={props.disabled}
        onChange={props.onSelect}
      />
      {props.label}
    </label>
  );
}

const ITEMS = '[role="menuitem"]:not(:disabled)';

/**
 * A menu in a portal next to `anchor` (a button's rect, or a zero-size rect at the pointer for a context
 * menu). It takes the focus, and gives it back on close. Arrows, Home, End and a first letter move; Enter
 * runs the item; Escape, Tab or a press outside closes it. A chosen item closes it too.
 */
export function Menu(props: {
  readonly label: string;
  readonly anchor: Rect;
  readonly onClose: () => void;
  readonly children: ComponentChildren;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const onClose = useRef(props.onClose);
  useLayoutEffect(() => {
    onClose.current = props.onClose;
  });
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const place = placeFloating(props.anchor, element.getBoundingClientRect(), viewport(), {
      side: "bottom",
      align: "start",
    });
    element.style.left = `${place.left}px`;
    element.style.top = `${place.top}px`;
    element.style.visibility = "visible";
  }, [props.anchor]);

  useEffect(() => {
    const before = document.activeElement;
    items()[0]?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node | null)) onClose.current();
    };
    addEventListener("pointerdown", outside, true);
    return () => {
      removeEventListener("pointerdown", outside, true);
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);

  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label={props.label}
      class="menu"
      style={{ visibility: "hidden" }}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          onClose.current();
          return;
        }
        const list = items();
        const next = menuMove(
          event.key,
          list.indexOf(document.activeElement as HTMLElement),
          list.map((item) => item.textContent ?? ""),
        );
        if (next === null) return;
        event.preventDefault();
        list[next]?.focus();
      }}
      onClick={(event) => {
        if ((event.target as Element).closest(ITEMS)) onClose.current();
      }}
    >
      {props.children}
    </div>,
    document.body,
  );
}

export function MenuItem(props: {
  readonly onSelect: () => void;
  readonly tip: string;
  /** A shortcut that does the same, shown at the right. */
  readonly keys?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly children: ComponentChildren;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      class="menu-item"
      data-danger={props.danger || undefined}
      data-tip={props.tip}
      disabled={props.disabled}
      onClick={props.onSelect}
    >
      {props.children}
      {props.keys ? <span class="menu-key">{props.keys}</span> : null}
    </button>
  );
}

export function MenuSep() {
  return <div class="menu-sep" role="separator" />;
}

/** A panel that floats over the map, with its heading, "Enlarge" to the full view, and Close. */
export function OverlayPanel(props: {
  readonly heading: string;
  readonly onEnlarge: () => void;
  readonly onClose: () => void;
  readonly children: ComponentChildren;
}) {
  return (
    <section class="overlay-panel" aria-label={props.heading}>
      <header class="overlay-head">
        <h2>{props.heading}</h2>
        <button type="button" class="btn" data-tip={`Open the full view of ${props.heading}.`} onClick={props.onEnlarge}>
          Enlarge
        </button>
        <button type="button" class="btn" aria-label="Close" data-tip={`Close ${props.heading}.`} onClick={props.onClose}>
          ×
        </button>
      </header>
      {props.children}
    </section>
  );
}
