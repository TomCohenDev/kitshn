import { useEffect, useState } from "preact/hooks";
import type { MachineView } from "../core/protocol.ts";
import { type Usage, type UsageRow, USAGE_WARNING, usageLevel } from "../core/usage.ts";
import { callApi } from "./store.ts";

const number = new Intl.NumberFormat("en");

const amount = (row: Pick<UsageRow, "unit">, value: number) =>
  row.unit === "count"
    ? number.format(value)
    : value < 1_000_000
      ? `${number.format(Math.round(value / 1000))} KB`
      : value < 1_000_000_000
        ? `${(value / 1_000_000).toFixed(1)} MB`
        : `${(value / 1_000_000_000).toFixed(2)} GB`;

const PERIOD: Record<UsageRow["period"], string> = {
  day: "today, resets at 00:00 UTC",
  month: "this month (UTC)",
  now: "now",
};

/** One limit as an ink-bordered bar; yellow from 80%, red at the limit, empty and "unknown" without a value. */
function Gauge(props: {
  label: string;
  share: number;
  level: "unknown" | "ok" | "warn" | "full";
  detail: string;
  docs?: string;
}) {
  const percent = Math.round(props.share * 100);
  return (
    <div class={`gauge ${props.level}`}>
      <div class="gauge-head">
        <strong>{props.label}</strong>
        {props.level === "ok" ? null : (
          <span
            class={`sticker${props.level === "warn" ? " wait" : props.level === "unknown" ? " info" : ""}`}
          >
            {props.level === "full" ? "full" : props.level === "unknown" ? "unknown" : `${percent}%`}
          </span>
        )}
      </div>
      <div
        class="gauge-bar"
        role="meter"
        aria-label={props.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, percent)}
      >
        <span style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
      <p class="muted">
        {props.detail}
        {props.docs ? (
          <>
            {" · "}
            <a
              href={props.docs}
              target="_blank"
              rel="noreferrer"
              data-tip="The Cloudflare page that names this limit."
            >
              limit
            </a>
          </>
        ) : null}
      </p>
    </div>
  );
}

/** K-1303: how close the account is to the free plan limits, and how full each machine is. */
export function UsageView(props: { machines: ReadonlyArray<MachineView> }) {
  const [usage, setUsage] = useState<Usage | { error: string } | null>(null);

  useEffect(() => {
    void callApi<Usage>("GET", "/api/usage").then(setUsage);
  }, []);

  return (
    <div class="table-view usage-view">
      <p class="muted">
        The use of the Cloudflare account against the free plan. A bar turns yellow at {USAGE_WARNING * 100}%
        of its limit. kitshn reads the numbers at most every 5 minutes; Cloudflare analytics lag a few
        minutes.
      </p>
      {usage === null ? <p class="muted">Reading the numbers…</p> : null}
      {usage && "error" in usage ? <p class="error">{usage.error}</p> : null}
      {usage && "rows" in usage ? (
        <>
          {usage.kitshnDown ? (
            <p class="error">
              kitshn itself is over a limit or down, so the Worker read these numbers without it:{" "}
              {usage.kitshnDown}
            </p>
          ) : null}
          <div class="gauges">
            {usage.rows.map((row) => (
              <Gauge
                key={row.label}
                label={row.label}
                share={(row.used ?? 0) / row.limit}
                level={usageLevel(row)}
                detail={[
                  row.used === null
                    ? `Unknown: ${row.error ?? "no value"}`
                    : `${amount(row, row.used)} of ${amount(row, row.limit)} ${PERIOD[row.period]}`,
                  row.note,
                ]
                  .filter(Boolean)
                  .join(". ")}
                docs={row.docs}
              />
            ))}
          </div>
          <p class="muted">Read at {new Date(usage.at).toLocaleTimeString()}.</p>
        </>
      ) : null}
      <h3>Machines</h3>
      {props.machines.length === 0 ? <p class="muted">No machine yet.</p> : null}
      <div class="gauges">
        {props.machines.map((view) => (
          <div key={view.machine.id} class="usage-machine">
            <strong>{view.machine.name}</strong>
            {view.sample ? (
              (["cpu", "memory", "disk"] as const).map((part) => {
                const share = view.sample?.[part] ?? 0;
                return (
                  <Gauge
                    key={part}
                    label={part === "cpu" ? "CPU" : part === "memory" ? "Memory" : "Disk"}
                    share={share}
                    level={share >= 1 ? "full" : share >= USAGE_WARNING ? "warn" : "ok"}
                    detail={`${Math.round(share * 100)}% in use, from the latest sample${view.online ? "" : " before it went offline"}`}
                  />
                );
              })
            ) : (
              <p class="muted">No sample yet; the daemon sends one each minute while it is online.</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
