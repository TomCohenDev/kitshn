import { useEffect, useState } from "preact/hooks";
import type { Resource } from "../core/model.ts";
import type { UptimeChange } from "../core/uptime.ts";
import { callApi } from "./store.ts";

const DAY_MS = 24 * 60 * 60_000;

/** K-1125, K-1126: the uptime row of the card panel, with the changes of the last 24 hours as a strip. */
export function UptimeRow(props: {
  resource: Resource;
  uptime: { readonly up: boolean; readonly since: number };
}) {
  const [changes, setChanges] = useState<ReadonlyArray<UptimeChange> | null>(null);
  const { resource, uptime } = props;

  useEffect(() => {
    void callApi<ReadonlyArray<UptimeChange>>("GET", `/api/uptime/${encodeURIComponent(resource.id)}`).then(
      (result) => setChanges("error" in result ? [] : result),
    );
  }, [resource.id, uptime.up, uptime.since]);

  const now = Date.now();
  const start = now - DAY_MS;
  const segments = (changes ?? []).map((change, index, all) => {
    const from = Math.max(change.at, start);
    const to = all[index + 1]?.at ?? now;
    return { up: change.up, left: (from - start) / DAY_MS, width: (to - from) / DAY_MS };
  });
  const fetched = resource.kind === "site.static" || resource.kind === "site.worker";
  return (
    <div class="uptime">
      <div class="row">
        <span
          class="label"
          data-tip={
            fetched
              ? "kitshn fetches each address every few minutes without a login. A private site answers with the Access login, so its check shows only that Cloudflare and Access answer."
              : "The daemon checks the site every 10 seconds; an offline machine counts as down."
          }
        >
          Uptime
        </span>
        <span class={`sticker${uptime.up ? " ok" : ""}`}>{uptime.up ? "up" : "down"}</span>
        <span class="muted">since {new Date(uptime.since).toLocaleString()}</span>
      </div>
      <div class="uptime-strip" role="img" aria-label="Up and down in the last 24 hours">
        {segments.map((segment) => (
          <span
            key={segment.left}
            class={segment.up ? "up" : "down"}
            style={{ left: `${segment.left * 100}%`, width: `${segment.width * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}
