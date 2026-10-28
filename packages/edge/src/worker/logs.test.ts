import { describe, expect, it } from "vitest";
import { CloudflareError } from "./cloudflare.ts";
import { type RunSource, deployRuns, searchWorker } from "./logs.ts";

const run = (id: string, at: number, output: string | null, reason: string | null = null): RunSource => ({
  id,
  at,
  repo: "owner/app",
  sha: "abcdef0123",
  state: reason ? "failed" : "done",
  reason,
  runId: "42",
  runAttempt: null,
  output,
});

describe("Worker logs and deploy runs (K-1806, K-1808)", () => {
  it("asks for the events of the card's script only, and says when the token lacks the permission", async () => {
    let body: unknown = null;
    const answer = await searchWorker(
      async <T>(_method: string, _path: string, sent?: unknown) => {
        body = sent;
        return {
          events: {
            count: 900,
            events: [
              { timestamp: 2, $metadata: { message: "second", level: "info", trigger: "GET /" } },
              { timestamp: 1, $metadata: { error: "first" } },
            ],
          },
        } as T;
      },
      "acct",
      "kitshn-app",
      { text: "x", from: 0, to: 10 },
    );
    expect(body).toMatchObject({
      parameters: {
        filters: [{ key: "$metadata.service", operation: "eq", value: "kitshn-app" }],
        needle: { value: "x" },
      },
    });
    expect(answer).toEqual({
      state: "lines",
      matched: 900,
      cut: false,
      lines: [
        { at: 1, source: "", text: "first" },
        { at: 2, source: "info GET /", text: "second" },
      ],
    });
    const refused = await searchWorker(
      async () => {
        throw new CloudflareError(403, "Forbidden");
      },
      "acct",
      "kitshn-app",
      { text: "", from: 0, to: 10 },
    );
    expect(refused).toEqual({ state: "needs-permission" });
  });

  it("keeps the runs in the range whose output or reason matches, with the lines that match", () => {
    const sources = [
      run("compose", 5, "build\nERROR: disk full\ndone"),
      run("static", 6, null, "Error: upload failed"),
      run("quiet", 7, "all fine"),
      run("old", 1, "ERROR long ago"),
    ];
    const runs = deployRuns(sources, { text: "error", from: 2, to: 10 });
    expect(runs.map((item) => [item.id, item.lines])).toEqual([
      ["compose", ["ERROR: disk full"]],
      ["static", null],
    ]);
    expect(runs[0]?.runUrl).toBe("https://github.com/owner/app/actions/runs/42/attempts/1");
  });
});
