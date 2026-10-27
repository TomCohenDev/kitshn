import { describe, expect, it } from "vitest";
import { parseAllowances } from "./machine.ts";

describe("allow list (K-818)", () => {
  it("takes one repo and one setting per entry", () => {
    expect(parseAllowances([{ repo: " a/b ", setting: "bind:/var/run/docker.sock" }])).toEqual([
      { repo: "a/b", setting: "bind:/var/run/docker.sock" },
    ]);
  });
  it("refuses an entry with more words, which would read as another setting", () => {
    expect(parseAllowances([{ repo: "a/b ports", setting: "privileged" }])).toBeTypeOf("string");
    expect(parseAllowances([{ repo: "a/b", setting: "privileged\tports" }])).toBeTypeOf("string");
  });
});
