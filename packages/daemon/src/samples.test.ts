import { describe, expect, it } from "vitest";
import { lastSamples } from "./samples.ts";

describe("the samples on the daemon's disk (K-605, K-606)", () => {
  it("gives the newest ones, oldest first, and leaves out a broken line", () => {
    const line = (at: number) => JSON.stringify({ at, cpu: 0.1, memory: 0.2, disk: 0.3 });
    const text = [line(1), "not json", line(2), line(3), ""].join("\n");
    expect(lastSamples(text, 2).map((sample) => sample.at)).toEqual([2, 3]);
    expect(lastSamples("", 60)).toEqual([]);
  });
});
