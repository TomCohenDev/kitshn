import { describe, expect, it } from "vitest";
import { type LinkReport, PAIR_WINDOW_MS, pairLinkReports } from "./links.ts";

let next = 0;
const report = (side: LinkReport["side"], at: number, extra: Partial<LinkReport> = {}): LinkReport => ({
  id: ++next,
  at,
  side,
  source: "mac",
  target: "vps",
  kind: "exec",
  thread: side === "source" ? "thread-1" : null,
  name: side === "source" ? "git" : "exec",
  cwd: null,
  outcome: "succeeded",
  exitCode: 0,
  ...extra,
});

describe("pairing the reports of both machines (K-1610)", () => {
  it("pairs a source and a target report of one call, one to one", () => {
    const source = report("source", 1000);
    const target = report("target", 1500);
    const second = report("source", 2000);
    const now = 1000 + PAIR_WINDOW_MS * 2;
    expect(pairLinkReports([target, source, second], now)).toEqual([
      { report: second, partner: null, check: "no target report" },
      { report: source, partner: target, check: "paired" },
    ]);
  });

  it("marks a call that only the target reported, so a source that skips its reports shows", () => {
    const served = report("target", 1000);
    expect(pairLinkReports([served], 1000 + PAIR_WINDOW_MS + 1)).toEqual([
      { report: served, partner: null, check: "no source report" },
    ]);
  });

  it("waits for the other side within the window, and pairs a tool call only by its name", () => {
    const source = report("source", 1000, { kind: "tool", name: "t3_thread_read" });
    const other = report("target", 1100, { kind: "tool", name: "t3_thread_send" });
    expect(pairLinkReports([source, other], 2000).map((item) => item.check)).toEqual(["waiting", "waiting"]);
    const far = report("target", 1000 + PAIR_WINDOW_MS + 1, { kind: "tool", name: "t3_thread_read" });
    expect(pairLinkReports([source, far], 1_000_000).map((item) => item.check)).toEqual([
      "no source report",
      "no target report",
    ]);
  });
});
