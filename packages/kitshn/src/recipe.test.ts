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
});
