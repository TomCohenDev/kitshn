import { describe, expect, it } from "vitest";
import { logAnswerOf, parseComposeLine, tailLines } from "./logs.ts";

describe("logs (K-1804, K-1807)", () => {
  it("reads a Compose line with nine digits of a second, and refuses a line without the shape", () => {
    expect(parseComposeLine("web-1  | 2026-10-28T10:00:00.123456789Z GET / 500 | x")).toEqual({
      at: Date.parse("2026-10-28T10:00:00.123Z"),
      source: "web-1",
      text: "GET / 500 | x",
    });
    expect(parseComposeLine("web-1  | not a time")).toBeNull();
    expect(parseComposeLine("Attaching to web-1")).toBeNull();
  });

  it("turns a trace-v1 tail event into its request line, its console lines and its exceptions", () => {
    const lines = tailLines({
      outcome: "exception",
      eventTimestamp: 5,
      event: { request: { method: "GET", url: "https://a.example.com/x?y=1" }, response: { status: 500 } },
      logs: [{ message: ["hello", { n: 1 }], level: "warn", timestamp: 6 }],
      exceptions: [{ name: "TypeError", message: "boom", timestamp: 7 }],
    });
    expect(lines).toEqual([
      { at: 5, source: "GET /x", text: "exception 500" },
      { at: 6, source: "GET /x warn", text: 'hello {"n":1}' },
      { at: 7, source: "GET /x exception", text: "TypeError: boom" },
    ]);
  });

  it("turns a daemon answer of the wrong shape into an error, and drops lines of the wrong shape", () => {
    expect(
      logAnswerOf({ state: "lines", matched: 2, lines: [{ at: 1, source: "a", text: "b" }, { at: "x" }] }),
    ).toEqual({ state: "lines", matched: 2, lines: [{ at: 1, source: "a", text: "b" }] });
    expect(logAnswerOf({ state: "needs-permission" })).toMatchObject({ state: "error" });
  });
});
