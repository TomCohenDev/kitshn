import type { DeployEvent } from "kitshn/recipe";

/** K-903: kitshn refuses a new preview at this many Worker scripts in the account. */
export const SCRIPT_LIMIT = 90;
/** A planned deploy must finish within this time. */
export const DEPLOY_MS = 60 * 60 * 1000;

const id = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** The card id and the Worker script name of one environment of a repo. */
export function environmentNames(repo: string, environment: string) {
  const resourceId = id(`app-${repo.replace("/", "-")}-${environment}`).slice(0, 56);
  return { resourceId, script: `kitshn-${resourceId}` };
}

export function parseEvent(value: unknown): DeployEvent | string {
  if (typeof value !== "object" || value === null) return "The deploy needs its GitHub event.";
  const event = value as Record<string, unknown>;
  if (event["name"] !== "push" && event["name"] !== "pull_request")
    return "kitshn deploys on push and pull_request.";
  if (typeof event["branch"] !== "string") return "The event needs its branch.";
  const pr = event["pr"];
  if (pr !== null && (typeof pr !== "number" || !Number.isInteger(pr) || pr < 1))
    return "The pull request number is not valid.";
  const action = event["action"];
  if (action !== null && typeof action !== "string") return "The pull request action is not valid.";
  return {
    name: event["name"],
    branch: event["branch"],
    pr: pr as number | null,
    action: action as string | null,
  };
}

/** The asset manifest of the direct upload flow: paths to a 32-hex hash and a size. */
export function parseManifest(value: unknown): Record<string, { hash: string; size: number }> | string {
  if (typeof value !== "object" || value === null) return "The deploy needs its file manifest.";
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 20_000) return "A static site has 1 to 20,000 files.";
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const [path, item] of entries) {
    const file = item as { hash?: unknown; size?: unknown } | null;
    if (!path.startsWith("/") || path.length > 500) return `The path ${path} is not valid.`;
    if (typeof file?.hash !== "string" || !/^[0-9a-f]{32}$/.test(file.hash))
      return `The hash of ${path} is not valid.`;
    if (typeof file.size !== "number" || file.size < 0 || file.size > 25 * 1024 * 1024) {
      return `${path} is larger than 25 MB, the limit of a static asset.`;
    }
    manifest[path] = { hash: file.hash, size: file.size };
  }
  return manifest;
}

/**
 * K-805: the Worker of a static site. Static assets answer every request first, so this code runs only
 * for a path that is not a file, and the free plan does not count asset requests.
 */
export const STATIC_WORKER = `export default { fetch(request, env) { return env.ASSETS.fetch(request); } };\n`;
