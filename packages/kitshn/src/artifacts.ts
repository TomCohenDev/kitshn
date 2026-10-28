import { join, resolve, sep } from "node:path";
import { DEFAULT_APP } from "./names.ts";

/** K-805: an artifact of an earlier job of the run, which goes into the output folder of one app. */
export interface Artifact {
  /** Where the artifact is now; null when the workflow downloaded it in place (`artifact-path`). */
  readonly from: string | null;
  /** The output folder that the workflow names for it, relative to the repo. */
  readonly path: string;
}

/**
 * K-805, K-804: the artifacts by app key, or why the input is wrong. `artifacts` of the workflow (KITSHN_ARTIFACTS,
 * downloaded to KITSHN_ARTIFACT_DIR) names them per app; `artifact` and `artifact-path` (KITSHN_ARTIFACT_PATH,
 * downloaded in place) are for the app `app`. A name is one plain folder name, and its folder stays inside
 * KITSHN_ARTIFACT_DIR, so an artifact can never copy the deploy params of the run beside it.
 */
export function artifactsByApp(
  keys: ReadonlyArray<string>,
  env: { readonly [name: string]: string | undefined },
): Map<string, Artifact> | { readonly error: string } {
  const byApp = new Map<string, Artifact>();
  const legacy = env["KITSHN_ARTIFACT_PATH"];
  if (legacy) byApp.set(DEFAULT_APP, { from: null, path: legacy });
  const text = env["KITSHN_ARTIFACTS"];
  if (!text) return byApp;
  let map: unknown;
  try {
    map = JSON.parse(text);
  } catch {
    return {
      error:
        'the artifacts input is not JSON. Write it as {"<app>": {"name": "<artifact>", "path": "<folder>"}}.',
    };
  }
  if (typeof map !== "object" || map === null || Array.isArray(map))
    return { error: "the artifacts input must be a JSON object." };
  const root = resolve(env["KITSHN_ARTIFACT_DIR"] ?? "");
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    const item = value as { name?: unknown; path?: unknown } | null;
    if (!keys.includes(key))
      return { error: `the artifacts input names the app ${key}, but the recipe has no such app.` };
    if (typeof item?.name !== "string" || typeof item.path !== "string")
      return { error: `the artifact of ${key} needs a name and a path.` };
    const name = item.name;
    const from = resolve(root, name);
    if (
      name === "" ||
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      !from.startsWith(root + sep)
    )
      return {
        error: `the artifact name ${JSON.stringify(name)} of ${key} must be a plain name, without ".", "..", "/" or "\\".`,
      };
    if (byApp.has(key)) return { error: `the app ${key} gets an artifact twice.` };
    byApp.set(key, { from: join(root, name), path: item.path });
  }
  return byApp;
}
