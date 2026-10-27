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

/**
 * The card id and the Worker script name of one environment of a repo. The repo id keeps two repos with
 * similar names apart (my.site and my-site).
 */
export function environmentNames(repoId: string, repo: string, environment: string) {
  const slug = id(repo.split("/")[1] ?? repo).slice(0, 20);
  const full = id(`app-${slug}-${repoId}-${environment}`);
  // A long name keeps a hash of the environment instead of cutting it, so two environments never meet.
  const resourceId = full.length <= 56 ? full : `app-${slug}-${repoId}-${fnv(environment)}`;
  return { resourceId, script: `kitshn-${resourceId}` };
}

/** FNV-1a, 32 bits, as 8 hex characters. */
function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

/**
 * K-811: the event from the signed token. Only the pull request action comes from the request, because
 * the token has none; it can only open or close the preview of the token's own pull request.
 */
export function eventOf(
  deployer: { eventName: string; branch: string; pr: number | null },
  value: unknown,
): (DeployEvent & { readonly claimed?: true }) | string {
  // K-718: a dispatch (by an agent key through the App, or by a repo member) runs one branch's code,
  // so it plans as a push of that branch.
  if (deployer.eventName === "push" || deployer.eventName === "workflow_dispatch")
    return { name: "push", branch: deployer.branch, pr: null, action: null };
  if (deployer.eventName !== "pull_request") {
    return `kitshn deploys on push, pull_request and workflow_dispatch, not on ${deployer.eventName}.`;
  }
  const action =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>)["action"] : null;
  if (typeof action !== "string") return "A pull request deploy needs its action.";
  if (deployer.pr !== null) return { name: "pull_request", branch: deployer.branch, pr: deployer.pr, action };
  // A closed pull request has no `refs/pull/<n>/` ref in its token, so its number comes from the request.
  // kitshn trusts it only to close the preview that the token's own head branch deployed (planDeploy).
  const pr = (value as Record<string, unknown>)["pr"];
  if (action !== "closed" || typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0)
    return { name: "pull_request", branch: deployer.branch, pr: null, action };
  return { name: "pull_request", branch: deployer.branch, pr, action, claimed: true };
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
