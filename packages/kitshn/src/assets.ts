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

/** The JSON of an answer, or its first 200 characters when it is no JSON (an error page). */
export function jsonOf<T>(text: string): { ok: true; value: T } | { ok: false; text: string } {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false, text: text.slice(0, 200) };
  }
}

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
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
    // Files are keyed by their hash, so a failed upload is safe to repeat; Cloudflare refuses it now and then.
    let failure = "";
    for (const pause of [5_000, 15_000, null]) {
      const response = await fetch(session.uploadUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${session.jwt}` },
        body: form,
      });
      const body = jsonOf<{ success?: boolean; result?: { jwt?: string }; errors?: unknown }>(
        await response.text(),
      );
      if (body.ok && body.value.success === true) {
        if (body.value.result?.jwt) completion = body.value.result.jwt;
        failure = "";
        break;
      }
      failure = `the file upload answered ${response.status}: ${body.ok ? JSON.stringify(body.value.errors) : body.text}`;
      if (pause === null) break;
      console.log(`kitshn: ${failure}; it tries again in ${pause / 1000} s.`);
      await wait(pause);
    }
    if (failure) fail(failure);
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
