import { type ComponentChildren, Fragment, createPortal } from "preact";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Action, ActionGroups } from "./actions.ts";
import { type WidthLimits, keyWidth, storedWidth } from "./layout.ts";
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

const ITEMS =
  '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)';

/**
 * A menu in a portal next to `anchor` (a button's rect, or a zero-size rect at the pointer for a context
 * menu). It takes the focus (the item `focus` names, else the first), and gives it back on close. Arrows,
 * Home, End and a first letter move; Enter runs the item; Escape goes `onBack` when it is set, else Escape,
 * Tab or a press outside closes it. A chosen item closes it too, except one with `data-keep-open`.
 */
export function Menu(props: {
  readonly label: string;
  readonly anchor: Rect;
  readonly onClose: () => void;
  readonly onBack?: () => void;
  readonly focus?: string;
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
    const list = items();
    (list.find((item) => item.dataset["key"] === props.focus) ?? list[0])?.focus();
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
          if (event.key === "Escape" && props.onBack) props.onBack();
          else onClose.current();
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
        const item = (event.target as Element).closest(ITEMS);
        if (item && !item.hasAttribute("data-keep-open")) onClose.current();
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
  /** The item opens a sub-list in the same menu. */
  readonly opens?: boolean;
  /** A choice keeps the menu open (an item that opens a sub-list, or Back). */
  readonly keepOpen?: boolean;
  /** A radio item of a group of options; true marks the current one. With `checkbox`, an item that is on or off. */
  readonly checked?: boolean;
  readonly checkbox?: boolean;
  /** kitshn refuses it now: it stays focusable so its tooltip says why, and a choice does nothing. */
  readonly unavailable?: boolean;
  /** Names the item for `Menu`'s `focus`. */
  readonly itemKey?: string;
  readonly children: ComponentChildren;
}) {
  return (
    <button
      type="button"
      role={props.checked === undefined ? "menuitem" : props.checkbox ? "menuitemcheckbox" : "menuitemradio"}
      aria-checked={props.checked}
      tabIndex={-1}
      class="menu-item"
      aria-haspopup={props.opens ? "menu" : undefined}
      aria-disabled={props.unavailable || undefined}
      data-keep-open={props.keepOpen || props.opens || props.unavailable || undefined}
      data-key={props.itemKey}
      data-danger={props.danger || undefined}
      data-tip={props.tip}
      disabled={props.disabled}
      onClick={props.onSelect}
    >
      {props.children}
      {props.checked ? <span class="menu-key">✓</span> : null}
      {props.keys ? <span class="menu-key">{props.keys}</span> : null}
    </button>
  );
}

export function MenuSep() {
  return <div class="menu-sep" role="separator" />;
}

/**
 * K-523: a menu of action groups. An action with a sub-list shows that list in the same menu, with "Back"
 * first, so the menu needs no second layer. The open sub-list is kept by id and read from the current
 * groups, so it never runs actions of an older state.
 */
export function ActionMenu(props: {
  readonly label: string;
  readonly anchor: Rect;
  readonly groups: ActionGroups;
  readonly onClose: () => void;
}) {
  const [path, setPath] = useState<{ readonly open: string | null; readonly from: string | null }>({
    open: null,
    from: null,
  });
  const open = props.groups
    .flat()
    .find((action): action is Extract<Action, { items: unknown }> => action.id === path.open && "items" in action);
  const back = () => setPath({ open: null, from: open?.id ?? null });
  const item = (action: Action) => {
    const shared = {
      key: action.id,
      itemKey: action.id,
      // A refused action stays visible, so its tooltip says why it does not run.
      tip: action.refused ?? action.tip,
      danger: action.danger ?? false,
      ...(action.checked === undefined ? {} : { checked: action.checked }),
    };
    if (action.refused !== undefined)
      return (
        <MenuItem {...shared} unavailable onSelect={() => undefined}>
          {action.label}
        </MenuItem>
      );
    return "items" in action ? (
      <MenuItem {...shared} opens onSelect={() => setPath({ open: action.id, from: null })}>
        {action.label}
        <span class="menu-key">▸</span>
      </MenuItem>
    ) : (
      <MenuItem {...shared} onSelect={action.run}>
        {action.label}
      </MenuItem>
    );
  };
  return (
    // A new key mounts a new menu, so the focus moves into the list that shows.
    <Menu
      key={open?.id ?? ""}
      label={open ? `${props.label}: ${open.label}` : props.label}
      anchor={props.anchor}
      onClose={props.onClose}
      {...(open ? { onBack: back } : {})}
      {...(path.from ? { focus: path.from } : {})}
    >
      {open ? (
        <>
          <MenuItem tip={`Back to the actions; leaves ${open.label}.`} keepOpen onSelect={back}>
            <span aria-hidden="true">◂ </span>Back
          </MenuItem>
          <MenuSep />
          {open.items.map(item)}
        </>
      ) : (
        props.groups.map((group, index) => (
          <Fragment key={index}>
            {index > 0 ? <MenuSep /> : null}
            {group.map(item)}
          </Fragment>
        ))
      )}
    </Menu>
  );
}

/** The "⋯" button of a card, a stack or a circle head: a keyboard path to its context menu (K-523). */
export function MoreButton(props: { readonly name: string; readonly onOpen: (anchor: Rect) => void }) {
  return (
    <button
      type="button"
      class="more"
      aria-haspopup="menu"
      aria-label={`Actions for ${props.name}`}
      data-tip={`Actions for ${props.name}. Right-click or a long press opens them too.`}
      // The map starts a drag on a press; this button only opens the menu.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        // A tray card selects itself on a click; this click only opens the menu.
        event.stopPropagation();
        props.onOpen(event.currentTarget.getBoundingClientRect());
      }}
    >
      ⋯
    </button>
  );
}

/**
 * A panel that floats over the map, with its heading, "Enlarge" to the full view, and Close. `large` is the
 * full view of the same content; its button "To the map" goes back to the panel.
 */
export function OverlayPanel(props: {
  readonly heading: string;
  readonly large: boolean;
  readonly onResize: () => void;
  readonly onClose: () => void;
  readonly children: ComponentChildren;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // A panel that opens takes the focus at its heading, so the keyboard and a screen reader land in it.
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  return (
    <section class={`overlay-panel${props.large ? " large" : ""}`} aria-labelledby={id}>
      <header class="overlay-head">
        <h2 id={id} ref={heading} tabIndex={-1}>
          {props.heading}
        </h2>
        <button
          type="button"
          class="btn"
          data-tip={
            props.large
              ? `Show ${props.heading} as a panel over the map again.`
              : `Open the full view of ${props.heading}.`
          }
          onClick={props.onResize}
        >
          {props.large ? "To the map" : "Enlarge"}
        </button>
        <button type="button" class="btn" aria-label="Close" data-tip={`Close ${props.heading}.`} onClick={props.onClose}>
          ×
        </button>
      </header>
      {props.children}
    </section>
  );
}

/** K-525: the width that the owner wants, which this device remembers inside its limits. */
export function useStoredWidth(key: string, limits: WidthLimits) {
  const [width, setWidth] = useState(() => storedWidth(localStorage.getItem(key), limits));
  const commit = (next: number) => {
    const kept = storedWidth(String(next), limits);
    setWidth(kept);
    localStorage.setItem(key, String(kept));
  };
  return [width, commit] as const;
}

/** K-525: the screen width, so the widths that show follow a window resize and the 720 px phone break. */
export function useScreenWidth() {
  const [width, setWidth] = useState(innerWidth);
  useEffect(() => {
    const update = () => setWidth(innerWidth);
    addEventListener("resize", update);
    return () => removeEventListener("resize", update);
  }, []);
  return width;
}

/**
 * K-525: the drag edge of the side panel or the shelf. A pointer drags it, and as a focusable separator the
 * arrow keys, Home and End move it. `grows` is the side the element grows to when the edge moves that way.
 * A drag changes only `cssVar`, so nothing renders until the drag ends; `fit` gives the width that may show
 * for a wanted one. Escape during a drag puts the start width back.
 */
export function ResizeEdge(props: {
  readonly label: string;
  readonly width: number;
  readonly limits: WidthLimits;
  readonly grows: "left" | "right";
  readonly cssVar: string;
  readonly fit: (wanted: number) => number;
  readonly onCommit: (width: number) => void;
}) {
  const drag = useRef<{ readonly x: number; readonly start: number; shown: number } | null>(null);
  const show = (width: number) => document.documentElement.style.setProperty(props.cssVar, `${width}px`);
  const end = (keep: boolean) => {
    const now = drag.current;
    if (!now) return;
    drag.current = null;
    removeEventListener("keydown", escape, true);
    if (keep && now.shown !== now.start) props.onCommit(now.shown);
    else show(now.start);
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    // The drag eats this Escape, so it never also closes the panel.
    event.stopPropagation();
    event.preventDefault();
    end(false);
  };
  return (
    <div
      class={`resize-edge ${props.grows === "left" ? "at-left" : "at-right"}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuemin={props.limits.min}
      aria-valuemax={props.limits.max}
      aria-valuenow={props.width}
      tabIndex={0}
      data-tip={`${props.label}: drag, or focus and use the arrow keys.`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, start: props.width, shown: props.width };
        addEventListener("keydown", escape, true);
      }}
      onPointerMove={(event) => {
        const now = drag.current;
        if (!now) return;
        // A release that the page missed (outside the window) ends the drag.
        if (event.buttons === 0) return end(true);
        const moved = event.clientX - now.x;
        now.shown = props.fit(now.start + (props.grows === "left" ? -moved : moved));
        show(now.shown);
      }}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onLostPointerCapture={() => end(true)}
      onKeyDown={(event) => {
        const next = keyWidth(event.key, props.width, props.limits, props.grows);
        if (next === null) return;
        event.preventDefault();
        props.onCommit(props.fit(next));
      }}
    />
  );
}
