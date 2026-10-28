import { useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  type PaletteCursor,
  type PaletteEntry,
  paletteActive,
  paletteArrow,
  paletteEnter,
} from "./actions.ts";

/** The entries whose label or keywords hold every word of the query, at most 50. */
const matching = (entries: ReadonlyArray<PaletteEntry>, query: string) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries
    .filter((entry) => {
      const text = `${entry.label} ${entry.keywords ?? ""}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .slice(0, 50);
};

const fresh: PaletteCursor = { label: null, picked: false };

/**
 * K-511: the command palette. It filters every entry by the words of the query; Enter runs the highlighted
 * entry, but a dangerous one only when it is the only match or the arrows picked it (K-523).
 */
export function Palette(props: {
  initialQuery: string;
  onClose: () => void;
  entries: ReadonlyArray<PaletteEntry>;
}) {
  const [query, setQuery] = useState(props.initialQuery);
  const [cursor, setCursor] = useState<PaletteCursor>(fresh);
  // Events sent in one task (a script or an agent: input, ArrowDown, Enter) arrive before any render, so the
  // keys read the query and the cursor as the last key left them, not as the last render showed them.
  const live = useRef({ query: props.initialQuery, cursor: fresh });
  const moveCursor = (query: string, next: PaletteCursor) => {
    live.current = { query, cursor: next };
    setCursor(next);
  };
  const matches = matching(props.entries, query);
  const labels = matches.map((entry) => entry.label);
  const { index: active } = paletteActive(labels, cursor);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  // `autoFocus` only sets the HTML attribute, which a browser applies at page load, not to a dialog opened
  // later; without this, ⌘K left the focus on the panel and the typing went nowhere. On close the focus goes
  // back to where it was.
  useLayoutEffect(() => {
    const before = document.activeElement;
    input.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  const run = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    props.onClose();
    entry.run();
  };
  return (
    <div class="scrim" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <div class="dialog" role="dialog" aria-label="Command palette">
        <input
          ref={input}
          aria-label="Find"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={matches[active] ? `${listId}-${active}` : undefined}
          placeholder="Find a card, a circle or an action. Try “share”."
          value={query}
          onInput={(event) => {
            const value = event.currentTarget.value;
            setQuery(value);
            moveCursor(value, fresh);
          }}
          onKeyDown={(event) => {
            // A key that finishes an IME composition is the composition's, not the palette's.
            if (event.isComposing) return;
            if (event.key === "Escape") props.onClose();
            else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter") {
              const now = event.currentTarget.value;
              const list = matching(props.entries, now);
              const names = list.map((entry) => entry.label);
              const from = now === live.current.query ? live.current.cursor : fresh;
              if (event.key === "Enter") {
                const at = paletteActive(names, from);
                const index = paletteEnter(list, at.index, at.picked);
                run(index === null ? undefined : list[index]);
              } else moveCursor(now, paletteArrow(event.key, names, from));
            } else return;
            event.preventDefault();
          }}
        />
        <ul role="listbox" id={listId} aria-label="Matches">
          {matches.map((entry, index) => (
            <li
              key={entry.label}
              id={`${listId}-${index}`}
              role="option"
              data-tip={
                entry.danger && matches.length > 1
                  ? `${entry.tip} Pick it with the arrows or a click; Enter alone does not run it.`
                  : entry.tip
              }
              data-danger={entry.danger || undefined}
              aria-selected={index === active}
              onClick={() => run(entry)}
              onMouseEnter={() => moveCursor(query, { label: entry.label, picked: false })}
            >
              {entry.label}
            </li>
          ))}
          {matches.length === 0 ? (
            <li role="option" aria-disabled="true" aria-selected="false">
              Nothing matches.
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
