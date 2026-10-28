import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keepBuild, keptId, keptTag, rollbackOverride, serviceImages, staleTags } from "./keep.ts";

describe("kept builds (K-821)", () => {
  it("runs a built service as <project>-<service> and a pulled one as its image", () => {
    const config = { services: { app: { build: { context: "." } }, cache: { image: "redis:7" } } };
    expect(serviceImages(config, "app-riffle-1-prod")).toEqual(
      new Map([
        ["app", "app-riffle-1-prod-app"],
        ["cache", "redis:7"],
      ]),
    );
    // A rollback pins each service to its kept tag and never pulls, so `redis:7` itself never changes.
    expect(rollbackOverride(config, "app-riffle-1-prod", "d1")).toEqual({
      services: {
        app: { image: keptTag("app-riffle-1-prod", "app", "d1"), pull_policy: "never" },
        cache: { image: keptTag("app-riffle-1-prod", "cache", "d1"), pull_policy: "never" },
      },
    });
  });

  it("keeps the build before the current one through a rollback, a roll forward and a second rollback", () => {
    const dir = mkdtempSync(join(tmpdir(), "kitshn-keep-"));
    try {
      const kept = () => [keptId(join(dir, "good")), keptId(join(dir, "good.prev"))];
      const up = (deployId: string, redeploy = false) => {
        const staged = join(dir, "good.next");
        mkdirSync(staged);
        writeFileSync(join(staged, "deploy-id"), `${deployId}\n`);
        keepBuild(dir, staged, redeploy, false);
      };
      up("d1");
      up("d2");
      expect(kept()).toEqual(["d2", "d1"]);
      // Each rollback names the build in good.prev/, which the daemon checks before it starts.
      for (const [target, other] of [
        ["d1", "d2"],
        ["d2", "d1"],
        ["d1", "d2"],
      ] as const) {
        expect(kept()[1]).toBe(target);
        up(target);
        expect(kept()).toEqual([target, other]);
      }
      up("d1", true);
      expect(kept()).toEqual(["d1", "d2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
