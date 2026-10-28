import { describe, expect, it } from "vitest";
import { type Analytics, analyticsRows, countRows, usageLevel } from "./usage.ts";

const empty: Analytics = {
  workers: [],
  objects: [],
  rows: [],
  objectStorage: [],
  kv: [],
  kvStorage: [],
  r2: [],
  r2Storage: [],
};
const used = (rows: ReadonlyArray<{ label: string; used: number }>, label: string) =>
  rows.find((row) => row.label === label)?.used;

describe("free plan usage (K-1303)", () => {
  it("sorts R2 actions into class A, class B and free, and names an unknown action", () => {
    const { rows, errors } = analyticsRows({
      ...empty,
      r2: [
        { sum: { requests: 3 }, dimensions: { actionType: "PutObject" } },
        { sum: { requests: 5 }, dimensions: { actionType: "GetObject" } },
        { sum: { requests: 7 }, dimensions: { actionType: "DeleteObject" } },
        { sum: { requests: 11 }, dimensions: { actionType: "NewThing" } },
      ],
    });
    expect(used(rows, "R2 class A operations")).toBe(3 + 11);
    expect(used(rows, "R2 class B operations")).toBe(5);
    expect(errors).toEqual([expect.stringContaining("NewThing")]);
  });

  it("gives a zone made after 2024-09-01 the limit of 200 DNS records", () => {
    const rows = countRows({
      seats: 0,
      applications: 0,
      serviceTokens: 0,
      scripts: 0,
      zones: [
        { name: "new.example", records: 1, createdOn: "2026-09-29T10:00:00Z" },
        { name: "old.example", records: 1, createdOn: "2024-08-31T23:59:59Z" },
      ],
    });
    expect(rows.find((row) => row.label === "DNS records of new.example")?.limit).toBe(200);
    expect(rows.find((row) => row.label === "DNS records of old.example")?.limit).toBe(1000);
  });

  it("warns at 80% and is full at the limit", () => {
    const row = { label: "x", limit: 50, period: "now", unit: "count", docs: "" } as const;
    expect(usageLevel({ ...row, used: 39 })).toBe("ok");
    expect(usageLevel({ ...row, used: 40 })).toBe("warn");
    expect(usageLevel({ ...row, used: 50 })).toBe("full");
  });
});
