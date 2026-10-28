import { describe, expect, it } from "vitest";
import { keptTag, serviceImages, staleTags } from "./keep.ts";

describe("kept builds (K-821)", () => {
  it("runs a built service as <project>-<service> and a pulled one as its image", () => {
    const config = { services: { app: { build: { context: "." } }, cache: { image: "redis:7" } } };
    expect(serviceImages(config, "app-riffle-1-prod")).toEqual(
      new Map([
        ["app", "app-riffle-1-prod-app"],
        ["cache", "redis:7"],
      ]),
    );
  });

  it("drops the tags of every deploy but the last two of the app, and no tag of another app", () => {
    const tags = [
      keptTag("app-a-1-prod", "app", "d1"),
      keptTag("app-a-1-prod", "app", "d2"),
      keptTag("app-a-1-prod", "app", "d3"),
      keptTag("app-a-1-prod-x", "app", "d1"),
    ];
    expect(staleTags(tags, "app-a-1-prod", ["d3", "d2"])).toEqual([keptTag("app-a-1-prod", "app", "d1")]);
  });
});
