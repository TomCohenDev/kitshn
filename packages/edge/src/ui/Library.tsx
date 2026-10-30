import { useEffect, useState } from "preact/hooks";
import type { LibraryItem } from "../core/library.ts";
import { type State, circlesHolding } from "../core/model.ts";
import { KINDS } from "./kinds.ts";
import { callApi } from "./store.ts";
import { whenText } from "./time.ts";

const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** K-1005, K-1006: every page and file, with a search, a preview and Delete. It reads the index, not R2. */
export function LibraryView(props: {
  state: State;
  /** The newest revision; the list loads again when it changes, for example after an upload. */
  revision: number;
  onToast: (text: string, error: boolean) => void;
  onShowCard: (id: string) => void;
}) {
  const [items, setItems] = useState<ReadonlyArray<LibraryItem> | null>(null);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    void callApi<Array<LibraryItem>>("GET", "/api/library").then((result) => {
      if ("error" in result) props.onToast(result.error, true);
      else setItems(result);
    });
  }, [props.revision]);

  const words = query.toLowerCase().split(" ").filter(Boolean);
  const shown = (items ?? []).filter((item) => {
    const text = [item.title, item.thread ?? "", item.machine ?? "", item.fileName ?? ""]
      .join(" ")
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });

  /** K-1006: no confirm and no undo, so the label names what goes; History records it. */
  const remove = async (item: LibraryItem) => {
    const result = await callApi<{ deleted: string }>("DELETE", `/api/library/${item.id}`);
    if ("error" in result) props.onToast(result.error, true);
    else {
      if (preview === item.id) setPreview(null);
      props.onToast(`Deleted ${item.title}. Its address no longer works.`, false);
    }
  };

  return (
    <div class="table-view">
      <p class="muted">
        Pages and files. A new one is private and waits in the tray; place its card in a circle to share it.
      </p>
      <input
        class="field"
        type="search"
        aria-label="Search the library"
        data-tip="Search pages and files by title, thread or machine."
        placeholder="Search by title, thread or machine"
        value={query}
        onInput={(event) => setQuery(event.currentTarget.value)}
      />
      {preview ? (
        <iframe
          class="preview"
          aria-label="Preview"
          sandbox="allow-scripts"
          src={`/api/library/${encodeURIComponent(preview)}/content`}
        />
      ) : null}
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Thread</th>
            <th>Machine</th>
            <th>Added</th>
            <th>Size</th>
            <th>Shared with</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((item) => {
            const resource = props.state.resources.get(item.id);
            const circles = circlesHolding(props.state, item.id).map((circle) => circle.name);
            return (
              <tr key={item.id}>
                <td data-label="Title">
                  {KINDS[item.kind].icon}{" "}
                  {resource?.addresses[0] ? (
                    <a href={`https://${resource.addresses[0]}`} target="_blank" rel="noreferrer">
                      {item.title}
                    </a>
                  ) : (
                    item.title
                  )}
                </td>
                <td data-label="Thread">{item.thread ?? "–"}</td>
                <td data-label="Machine">{item.machine ?? "–"}</td>
                <td data-label="Added">{whenText(item.createdAt)}</td>
                <td data-label="Size">{size(item.size)}</td>
                <td data-label="Shared with">
                  {circles.length > 0 ? (
                    circles.join(", ")
                  ) : (
                    <span class="muted" data-tip="Private: no circle holds it, so only the admin sees it.">
                      private
                    </span>
                  )}
                </td>
                <td>
                  <button
                    class="btn"
                    data-tip={
                      preview === item.id
                        ? "Hide the preview."
                        : `Show a preview of ${item.title} above the table.`
                    }
                    onClick={() => setPreview(preview === item.id ? null : item.id)}
                  >
                    {preview === item.id ? "Hide" : "Preview"}
                  </button>
                  <button
                    class="btn"
                    data-tip="Show its card and panel on the map."
                    onClick={() => props.onShowCard(item.id)}
                  >
                    Card
                  </button>
                  <button
                    class="btn danger"
                    data-tip={`Delete ${item.title} at once: its stored ${item.kind} and its card go, and its address stops working for everyone. Undo cannot bring it back.`}
                    onClick={() => void remove(item)}
                  >
                    Delete {item.kind} for good
                  </button>
                </td>
              </tr>
            );
          })}
          {items !== null && shown.length === 0 ? (
            <tr>
              <td colSpan={7}>
                {items.length === 0 ? "No page or file yet." : "Nothing matches the search."}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
