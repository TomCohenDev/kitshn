import { describe, expect, it } from "vitest";
import { defineApp, defineApps } from "./index.ts";

// The package typecheck runs this file, so each `@ts-expect-error` below must stay an error.
describe("recipe types (K-804, K-820)", () => {
  const site = { static: { output: "site" }, deploy: [{ on: "push", name: "prod" }] } as const;

  it("takes only the keys of the file in needs.apps", () => {
    expect(Object.keys(defineApps({ app: site, cv: { ...site, needs: { apps: ["app"] } } }))).toEqual([
      "app",
      "cv",
    ]);
    // @ts-expect-error: no app of the file has the key "ap".
    defineApps({ app: site, cv: { ...site, needs: { apps: ["ap"] } } });
    // @ts-expect-error: one app has no other app to need.
    defineApp({ ...site, needs: { apps: ["api"] } });
  });
});
