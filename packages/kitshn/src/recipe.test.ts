import { describe, expect, it } from "vitest";
import { readRecipe } from "./parse.ts";
import { decodeRecipe, plan } from "./recipe.ts";

const source = `import { defineApp } from "kitshn";

export default defineApp({
  static: { output: "site" },
  deploy: [
    { on: "push", branch: "main", name: "prod", startsIn: "Everyone" },
    { on: "pull_request", name: "pr-{pr}", ephemeral: true },
  ],
});
`;

describe("recipe reader (K-802, K-803)", () => {
  it("reads a literal recipe without running it", () => {
    expect(decodeRecipe(readRecipe(source)).deploy[0]).toEqual({
      on: "push",
      branch: "main",
      name: "prod",
      startsIn: "Everyone",
    });
  });

  it("refuses code that computes, other imports and unknown keys", () => {
    expect(() => readRecipe(source.replace('output: "site"', "output: process.env.OUT"))).toThrow(/computes/);
    expect(() => readRecipe(source.replace('"site"', "`${1}`"))).toThrow(/computes/);
    expect(() => readRecipe(`import fs from "node:fs";\n${source}`)).toThrow(/imports only/);
    expect(() => readRecipe(`${source}\nconsole.log(1);`)).toThrow(/not allowed/);
    expect(() =>
      decodeRecipe(readRecipe(source.replace('output: "site"', 'output: "site", extra: 1'))),
    ).toThrow();
    const compose = (file: string) => ({ compose: { file }, deploy: [{ on: "push", name: "prod" }] });
    expect(decodeRecipe(compose("deploy/compose.yml"))).toMatchObject(compose("deploy/compose.yml"));
    expect(() => decodeRecipe(compose("/etc/compose.yml"))).toThrow(/inside the repo/);
    expect(() => decodeRecipe(compose("../other/compose.yml"))).toThrow(/inside the repo/);
    expect(() => decodeRecipe(compose(""))).toThrow(/inside the repo/);
  });
});

describe("plan (K-807, K-901, K-904)", () => {
  const recipe = decodeRecipe(readRecipe(source));
  const zone = "example.com";

  it("deploys main to the repo address and a pull request one level under the zone", () => {
    expect(
      plan(recipe, "me/Hello_App", { name: "push", branch: "main", pr: null, action: null }, zone),
    ).toMatchObject({
      kind: "deploy",
      environment: "prod",
      address: "hello-app.example.com",
      startsIn: "Everyone",
    });
    expect(
      plan(recipe, "me/hello", { name: "pull_request", branch: "x", pr: 1, action: "opened" }, zone),
    ).toMatchObject({
      kind: "deploy",
      address: "hello-pr-1.example.com",
      ephemeral: true,
    });
  });

  it("tears an ephemeral environment down when its pull request closes, and skips other branches", () => {
    expect(
      plan(recipe, "me/hello", { name: "pull_request", branch: "x", pr: 1, action: "closed" }, zone).kind,
    ).toBe("teardown");
    expect(plan(recipe, "me/hello", { name: "push", branch: "dev", pr: null, action: null }, zone).kind).toBe(
      "skip",
    );
  });

  it("refuses an address outside the zone or two levels deep", () => {
    const deep = decodeRecipe({
      static: { output: "." },
      deploy: [{ on: "push", name: "prod", address: "a.b.example.com" }],
    });
    expect(plan(deep, "me/x", { name: "push", branch: "main", pr: null, action: null }, zone)).toMatchObject({
      kind: "error",
    });
    const outside = decodeRecipe({
      static: { output: "." },
      deploy: [{ on: "push", name: "prod", address: "x.other.com" }],
    });
    expect(
      plan(outside, "me/x", { name: "push", branch: "main", pr: null, action: null }, zone),
    ).toMatchObject({ kind: "error" });
  });

  it("names a pull request environment only after the token's number", () => {
    const sneaky = decodeRecipe({
      static: { output: "site" },
      deploy: [{ on: "pull_request", name: "prod", ephemeral: true }],
    });
    expect(
      plan(sneaky, "me/x", { name: "pull_request", branch: "x", pr: 3, action: "closed" }, "example.com"),
    ).toMatchObject({
      kind: "error",
    });
  });
});

describe("Compose recipes (K-804, K-812)", () => {
  const deploy = [{ on: "push", branch: "main", name: "prod" }];
  it("takes a Compose app with labels", () => {
    expect(decodeRecipe({ compose: { runsOn: ["docker"] }, deploy })).toEqual({
      compose: { runsOn: ["docker"] },
      deploy,
    });
  });
  it("refuses a recipe with two kinds or none", () => {
    expect(() => decodeRecipe({ compose: {}, static: { output: "dist" }, deploy })).toThrow();
    expect(() => decodeRecipe({ deploy })).toThrow();
  });
});

describe("several addresses (K-817)", () => {
  const push = { name: "push", branch: "main", pr: null, action: null } as const;
  const withAddress = (address: string | ReadonlyArray<string>, on: "push" | "pull_request" = "push") =>
    decodeRecipe({ compose: {}, deploy: [{ on, name: on === "push" ? "prod" : "pr-{pr}", address }] });
  const zones = ["onion-climbers.com"];

  it("serves every listed address, the first under the kitshn zone as the main one", () => {
    const recipe = withAddress(["onion-climbers.com", "climbing.example.com", "www.onion-climbers.com"]);
    expect(plan(recipe, "me/climbing", push, "example.com", zones)).toMatchObject({
      kind: "deploy",
      address: "climbing.example.com",
      addresses: ["climbing.example.com", "onion-climbers.com", "www.onion-climbers.com"],
    });
    expect(plan(withAddress("climbing.example.com"), "me/climbing", push, "example.com")).toMatchObject({
      addresses: ["climbing.example.com"],
    });
  });

  it("refuses a list without the kitshn zone, a zone kitshn does not publish on, a deep name and a repeat", () => {
    const refused = (address: ReadonlyArray<string>) =>
      plan(withAddress(address), "me/x", push, "example.com", zones);
    expect(refused(["onion-climbers.com"])).toMatchObject({
      kind: "error",
      reason: expect.stringContaining("One address must be"),
    });
    expect(refused(["x.example.com", "other.org"])).toMatchObject({
      kind: "error",
      reason: expect.stringContaining("other.org"),
    });
    expect(refused(["x.example.com", "a.b.onion-climbers.com"])).toMatchObject({ kind: "error" });
    expect(refused(["x.example.com", "x.example.com"])).toMatchObject({
      kind: "error",
      reason: expect.stringContaining("twice"),
    });
  });

  it("keeps one address for a pull request (K-901)", () => {
    const recipe = withAddress(["a.example.com", "b.example.com"], "pull_request");
    expect(
      plan(recipe, "me/x", { name: "pull_request", branch: "x", pr: 1, action: "opened" }, "example.com"),
    ).toMatchObject({
      kind: "error",
      reason: expect.stringContaining("Only a push entry"),
    });
  });
});
