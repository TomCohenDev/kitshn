import { useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { type PaletteCursor, type PaletteEntry, paletteActive, paletteArrow, paletteEnter } from "./actions.ts";

/**
 * K-511: the command palette. It filters every entry by the words of the query; Enter runs the highlighted
 * entry, but a dangerous one only when it is the only match or the arrows picked it (K-523).
 */
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

export function Palette(props: {
  initialQuery: string;
  onClose: () => void;
  entries: ReadonlyArray<PaletteEntry>;
}) {
  const [query, setQuery] = useState(props.initialQuery);
  const [cursor, setCursor] = useState<PaletteCursor>({ label: null, picked: false });
  const matches = matching(props.entries, query);
  const labels = matches.map((entry) => entry.label);
  const { index: active, picked } = paletteActive(labels, cursor);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  // `autoFocus` only sets the HTML attribute, which a browser applies at page load, not to a dialog opened
  // later; without this, ⌘K left the focus on the panel and the typing went nowhere.
  useLayoutEffect(() => input.current?.focus(), []);
  const run = (index: number) => {
    const entry = matches[index];
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
            setQuery((event.target as HTMLInputElement).value);
            setCursor({ label: null, picked: false });
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") props.onClose();
            else if (event.key === "ArrowDown" || event.key === "ArrowUp")
              setCursor(paletteArrow(event.key, labels, cursor));
            else if (event.key === "Enter") {
              // Typing and Enter can arrive before a render; Enter then acts on the query that the input holds
              // now, with its first match and nothing picked, so a dangerous entry never runs by accident.
              const now = event.currentTarget.value;
              const fresh = now === query ? null : matching(props.entries, now);
              const index = fresh ? paletteEnter(fresh, 0, false) : paletteEnter(matches, active, picked);
              const entry = index === null ? undefined : (fresh ?? matches)[index];
              if (entry) {
                props.onClose();
                entry.run();
              }
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
              data-tip={entry.danger && matches.length > 1 ? `${entry.tip} Pick it with the arrows or a click; Enter alone does not run it.` : entry.tip}
              data-danger={entry.danger || undefined}
              aria-selected={index === active}
              onClick={() => run(index)}
              onMouseEnter={() => setCursor({ label: entry.label, picked: false })}
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
