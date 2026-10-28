import { describe, expect, it } from "vitest";
import { artifactsByApp } from "./artifacts.ts";

describe("artifacts by app (K-805, K-804)", () => {
  const dir = "/runner/kitshn-artifacts";
  const env = (artifacts: unknown, extra: Record<string, string> = {}) => ({
    KITSHN_ARTIFACTS: JSON.stringify(artifacts),
    KITSHN_ARTIFACT_DIR: dir,
    ...extra,
  });

  it("puts each artifact of the input at its app, and artifact-path at the app `app`", () => {
    expect(
      artifactsByApp(
        ["app", "cv"],
        env({ cv: { name: "cv", path: "cv/public" } }, { KITSHN_ARTIFACT_PATH: "public" }),
      ),
    ).toEqual(
      new Map([
        ["app", { from: null, path: "public" }],
        ["cv", { from: `${dir}/cv`, path: "cv/public" }],
      ]),
    );
  });

  it("refuses a name that leaves the artifact folder, such as the one with the deploy params", () => {
    for (const name of ["..", ".", "", "a/b", "..\\x", "../kitshn-params.json"])
      expect(artifactsByApp(["cv"], env({ cv: { name, path: "cv" } }))).toHaveProperty("error");
  });

  it("refuses an unknown app, a second artifact for the app `app`, and text that is not JSON", () => {
    expect(artifactsByApp(["app"], env({ cv: { name: "cv", path: "cv" } }))).toHaveProperty("error");
    expect(
      artifactsByApp(
        ["app"],
        env({ app: { name: "site", path: "public" } }, { KITSHN_ARTIFACT_PATH: "public" }),
      ),
    ).toHaveProperty("error");
    expect(artifactsByApp(["app"], { KITSHN_ARTIFACTS: "{", KITSHN_ARTIFACT_DIR: dir })).toHaveProperty(
      "error",
    );
  });
});
