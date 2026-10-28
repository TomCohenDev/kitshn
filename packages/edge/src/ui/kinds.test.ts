import { describe, expect, it } from "vitest";
import type { Resource } from "../core/model.ts";
import { pullRequestOf } from "./kinds.ts";

const card = (name: string, kind: Resource["kind"] = "site.compose"): Resource => ({
  id: name,
  kind,
  name,
  addresses: [],
  status: "running",
  group: null,
  machine: null,
});

describe("pullRequestOf (K-807)", () => {
  it("reads the pr-<n> environment of a site card and nothing else", () => {
    expect(
      ["tick3d pr-248", "tick3d", "tick3d-cv pr-7", "x pr-", "x pr-4a", "x pr-0", "x staging"].map((name) =>
        pullRequestOf(card(name)),
      ),
    ).toEqual([248, null, 7, null, null, null, null]);
    expect(pullRequestOf(card("notes pr-3", "page"))).toBeNull();
  });
});
