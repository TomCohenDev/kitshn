import { ICON_LIMIT, type IconType, iconType } from "kitshn/icon";
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
  const slug = slugOf(repo);
  const full = id(`app-${slug}-${repoId}-${environment}`);
  // A long name keeps a hash of the environment instead of cutting it, so two environments never meet.
  const resourceId = full.length <= 56 ? full : `app-${slug}-${repoId}-${fnv(environment)}`;
  return { resourceId, script: `kitshn-${resourceId}` };
}

const slugOf = (repo: string) => id(repo.split("/")[1] ?? repo).slice(0, 20);

/**
 * K-819: the repo id inside a card id that `environmentNames` made from this repo name and environment,
 * or null when the card id has another form (card ids from before the repo id, or another repo).
 */
export function repoIdOf(repo: string, environment: string, resourceId: string): string | null {
  const prefix = `app-${slugOf(repo)}-`;
  if (!resourceId.startsWith(prefix)) return null;
  const rest = resourceId.slice(prefix.length);
  const end = rest.indexOf("-");
  const candidate = end === -1 ? rest : rest.slice(0, end);
  if (candidate === "") return null;
  return environmentNames(candidate, repo, environment).resourceId === resourceId ? candidate : null;
}

/**
 * K-819: the repo ids of the deploy rows from before the gate, and the repos that count as allowed: each
 * repo with a finished deploy (a teardown alone does not count). `unknown` lists the rows without an id.
 * Later rows win the repo name.
 */
export function legacyRepos(
  deploys: ReadonlyArray<{
    readonly id: string;
    readonly repo: string;
    readonly environment: string;
    readonly resourceId: string;
    readonly kind: string;
    readonly state: string;
  }>,
) {
  const repoIds = new Map<string, string>();
  const allowed = new Map<string, string>();
  const unknown: Array<string> = [];
  for (const deploy of deploys) {
    const repoId = repoIdOf(deploy.repo, deploy.environment, deploy.resourceId);
    if (repoId === null) {
      unknown.push(deploy.id);
      continue;
    }
    repoIds.set(deploy.id, repoId);
    if (deploy.kind === "deploy" && deploy.state === "done") allowed.set(repoId, deploy.repo);
  }
  return { repoIds, allowed, unknown };
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
 * K-1113: the site icon that the CLI sends with `/deploy/finish`, as base64. Null means the site has none, so
 * kitshn drops a stored icon. A missing field is a CLI from before card icons: the stored icon stays.
 */
export function parseSiteIcon(
  value: unknown,
): { readonly bytes: Uint8Array; readonly type: IconType } | null | undefined | string {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") return "The site icon must be base64 text or null.";
  // Base64 grows by 4/3, so a longer text cannot fit the limit; this check comes before the decode.
  if (value.length > Math.ceil(ICON_LIMIT / 3) * 4) return `The site icon is larger than ${ICON_LIMIT / 1024} KB.`;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    return "The site icon is not valid base64.";
  }
  if (bytes.length === 0 || bytes.length > ICON_LIMIT) return `The site icon is empty or larger than ${ICON_LIMIT / 1024} KB.`;
  const type = iconType(bytes);
  if (type === null) return "The site icon is not a PNG, ICO, GIF, JPEG, WebP or SVG image.";
  return { bytes, type };
}

/** K-805: the most text of a `_headers` file that kitshn passes on; Cloudflare allows 100 rules. */
export const HEADERS_LIMIT = 100_000;

/**
 * K-805: the `_headers` file of a static site, which Cloudflare applies to its responses. Null or a missing field (a
 * CLI from before `_headers`) means none.
 */
export function parseHeadersFile(value: unknown): string | null | { readonly error: string } {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return { error: "The _headers file must be text or null." };
  if (value.length > HEADERS_LIMIT) return { error: `The _headers file is larger than ${HEADERS_LIMIT / 1000} KB.` };
  return value;
}

/**
 * K-805: the Worker of a static site. Static assets answer every request first, so this code runs only
 * for a path that is not a file, and the free plan does not count asset requests.
 */
export const STATIC_WORKER = `export default { fetch(request, env) { return env.ASSETS.fetch(request); } };\n`;
