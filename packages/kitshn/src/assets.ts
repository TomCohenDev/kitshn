// K-805, K-1123: the upload of a folder of files as Workers static assets.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fail } from "./cli-error.ts";
import { headersWarnings, redirectsWarnings } from "./headers.ts";
import { pickSiteIcon } from "./icon.ts";
import { contentType } from "./media.ts";
import { isHiddenName } from "./names.ts";

/**
 * The files of a static site. It skips dotfiles and dot folders (.git holds the checkout token) and does
 * not follow symlinks, so nothing outside the output folder is published.
 */
const files = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((name) => {
    if (isHiddenName(name)) return [];
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return [];
    return stat.isDirectory() ? files(path) : [path];
  });

/**
 * K-805: uploads a folder of files through the Workers direct upload flow, and picks the card icon (K-1112).
 * `_headers` and `_redirects` are config that Cloudflare reads, not files to serve.
 */
export type AssetSession = { jwt: string; buckets: Array<Array<string>>; uploadUrl: string };

/**
 * K-805, K-1123: uploads the files of `output` as Workers static assets. `open` asks kitshn for the upload session of
 * the manifest: a repo deploy with its GitHub token, a folder site with the agent key.
 */
export async function uploadAssets(
  output: string,
  open: (manifest: Record<string, { hash: string; size: number }>) => Promise<AssetSession>,
) {
  const manifest: Record<string, { hash: string; size: number }> = {};
  const byHash = new Map<string, { path: string; type: string }>();
  const byPath = new Map<string, string>();
  let headers: string | null = null;
  let redirects: string | null = null;
  for (const path of files(output)) {
    if (relative(output, path) === "_headers") {
      headers = readFileSync(path, "utf8");
      for (const warning of headersWarnings(headers)) console.log(`kitshn: warning: ${warning}`);
      continue;
    }
    if (relative(output, path) === "_redirects") {
      redirects = readFileSync(path, "utf8");
      for (const warning of redirectsWarnings(redirects)) console.log(`kitshn: warning: ${warning}`);
      continue;
    }
    const bytes = readFileSync(path);
    const extension = extname(path).toLowerCase();
    const hash = createHash("sha256")
      .update(bytes.toString("base64") + extension.slice(1))
      .digest("hex")
      .slice(0, 32);
    const sitePath = `/${relative(output, path).split("\\").join("/")}`;
    manifest[sitePath] = { hash, size: bytes.length };
    byPath.set(sitePath, path);
    byHash.set(hash, { path, type: contentType(path) });
  }
  if (Object.keys(manifest).length === 0) fail(`the folder ${output} is empty.`);
  const session = await open(manifest);
  let completion = session.jwt;
  for (const bucket of session.buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const file = byHash.get(hash);
      if (!file) fail(`Cloudflare asked for an unknown file ${hash}.`);
      form.append(hash, new Blob([readFileSync(file!.path).toString("base64")], { type: file!.type }), hash);
    }
    const response = await fetch(session.uploadUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${session.jwt}` },
      body: form,
    });
    const body = (await response.json()) as { success: boolean; result?: { jwt?: string }; errors?: unknown };
    if (!body.success) fail(`the file upload failed: ${JSON.stringify(body.errors)}`);
    if (body.result?.jwt) completion = body.result.jwt;
  }
  // K-1112: the card icon comes from the files; a site without one gets its kind icon.
  const { icon, notes } = await pickSiteIcon((path) => {
    const file = byPath.get(path);
    return file === undefined ? null : readFileSync(file);
  });
  for (const note of notes) console.log(`kitshn: icon: ${note}`);
  console.log(
    icon
      ? `kitshn: the card icon is ${icon.path}.`
      : "kitshn: the site has no icon; the card shows the kind icon.",
  );
  if (headers !== null) console.log("kitshn: the site sets its own headers with _headers.");
  if (redirects !== null) console.log("kitshn: the site sets its own redirects with _redirects.");
  return {
    jwt: completion,
    icon: icon ? Buffer.from(icon.bytes).toString("base64") : null,
    headers,
    redirects,
    count: Object.keys(manifest).length,
  };
}
