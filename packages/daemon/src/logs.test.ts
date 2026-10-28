import { describe, expect, it } from "vitest";
import { LOG_LIMITS, searchLogs, withLogLimits } from "./logs.ts";

const lines = [
  "web-1  | 2026-10-28T10:00:03.000000000Z boom three",
  "db-1   | 2026-10-28T10:00:01.000000000Z boom one",
  "web-1  | 2026-10-28T10:00:05.000000000Z quiet",
  "db-1   | 2026-10-28T09:00:00.000000000Z boom too early",
  "db-1   | 2026-10-28T10:00:02.000000000Z BOOM two",
];

describe("Compose logs on the daemon (K-1803, K-1804)", () => {
  it("keeps the lines in the range that match, in time order across containers", async () => {
    const answer = await searchLogs(
      ["printf", [`${lines.join("\n")}\n`]],
      { text: "boom", from: Date.parse("2026-10-28T10:00:00Z"), to: Date.parse("2026-10-28T11:00:00Z") },
      process.cwd(),
    );
    expect(answer).toEqual({
      state: "lines",
      matched: 3,
      lines: [
        { at: Date.parse("2026-10-28T10:00:01Z"), source: "db-1", text: "boom one" },
        { at: Date.parse("2026-10-28T10:00:02Z"), source: "db-1", text: "BOOM two" },
        { at: Date.parse("2026-10-28T10:00:03Z"), source: "web-1", text: "boom three" },
      ],
    });
  });

  it("reports a failed docker compose logs as an error", async () => {
    const answer = await searchLogs(
      ["sh", ["-c", "echo no such project >&2; exit 3"]],
      { text: "", from: 0, to: 1 },
      process.cwd(),
    );
    expect(answer).toMatchObject({ state: "error", error: expect.stringMatching(/no such project/) });
  });

  it("limits the logs of each service, and keeps a driver that the owner allows", () => {
    const config = {
      name: "app",
      services: {
        web: { image: "a" },
        json: { image: "b", logging: { driver: "json-file" } },
        syslog: { image: "c", logging: { driver: "syslog" } },
      },
    };
    expect(withLogLimits(config)).toEqual({
      name: "app",
      services: {
        web: { image: "a", logging: LOG_LIMITS },
        json: { image: "b", logging: LOG_LIMITS },
        syslog: { image: "c", logging: { driver: "syslog" } },
      },
    });
  });
});
