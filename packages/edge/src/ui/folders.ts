import { pickSiteIcon } from "kitshn/icon";
import { contentType } from "kitshn/media";
import { isHiddenName } from "kitshn/names";
import { callApi } from "./store.ts";

/** One file of a dropped or picked folder, with its path in the site, such as `/css/site.css`. */
export interface FolderFile {
  readonly path: string;
  readonly file: File;
}

/**
 * K-1129: the parts of an upload stay below the Worker's limit of a part (40 MB), in base64. Known limit: the browser
 * holds the whole folder in base64 in memory. Revisit when owners drop folders of several hundred MB.
 */
const PART_BYTES = 30 * 1024 * 1024;
/** Workers static assets take a file of at most 25 MiB. */
const FILE_BYTES = 25 * 1024 * 1024;

/** The files of a folder, and how many hidden files and folders it left out, as the CLI does (K-805). */
export interface FolderFiles {
  readonly files: Array<FolderFile>;
  readonly skipped: number;
}

/** The files of a folder that the owner dropped, from its entry, with paths from the folder's root. */
export async function droppedFolder(entry: FileSystemDirectoryEntry): Promise<FolderFiles> {
  const found: Array<FolderFile> = [];
  let skipped = 0;
  const walk = async (directory: FileSystemDirectoryEntry, prefix: string): Promise<void> => {
    const reader = directory.createReader();
    // readEntries gives at most 100 entries a call; an empty answer ends the folder.
    for (;;) {
      const entries = await new Promise<Array<FileSystemEntry>>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (entries.length === 0) return;
      for (const child of entries) {
        // A hidden folder such as .git is not read at all; it counts once.
        if (isHiddenName(child.name)) skipped++;
        else if (child.isDirectory) await walk(child as FileSystemDirectoryEntry, `${prefix}/${child.name}`);
        else {
          const file = await new Promise<File>((resolve, reject) =>
            (child as FileSystemFileEntry).file(resolve, reject),
          );
          found.push({ path: `${prefix}/${child.name}`, file });
        }
      }
    }
  };
  await walk(entry, "");
  return { files: found, skipped };
}

/** The files of a folder that the owner picked with a folder input; each path starts with the folder name. */
export function pickedFolder(files: ReadonlyArray<File>): FolderFiles & { folder: string } {
  const folder = files[0]?.webkitRelativePath.split("/")[0] ?? "";
  const all = files.map((file) => ({ path: file.webkitRelativePath.slice(folder.length), file }));
  const shown = all.filter((item) => !item.path.split("/").some(isHiddenName));
  return { folder, files: shown, skipped: all.length - shown.length };
}

const base64 = (bytes: Uint8Array) => {
  let text = "";
  for (let start = 0; start < bytes.length; start += 0x8000)
    text += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(text);
};

/** The asset hash of Cloudflare, as the kitshn CLI makes it (K-805). */
async function assetHash(content: string, path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content + extension));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/**
 * K-1129: uploads a folder as a folder site through kitshn. `target` is a new site (the folder name and the drop
 * point, or null for the tray) or a new version of the folder site `card`. Returns the card and its address.
 */
export async function uploadFolder(
  target:
    { readonly folder: string; readonly at: { x: number; y: number } | null } | { readonly card: string },
  { files, skipped }: FolderFiles,
  progress: (text: string) => void,
): Promise<{ card: string; address: string; updated: boolean } | { error: string }> {
  const hidden = skipped === 0 ? "" : ` · skipped ${skipped} hidden ${skipped === 1 ? "file" : "files"}`;
  const onProgress = (text: string) => progress(`${text}${hidden}`);
  const tooBig = files.filter((item) => item.file.size > FILE_BYTES);
  if (tooBig.length > 0)
    return { error: `${tooBig.map((item) => item.path).join(", ")}: a site file is at most 25 MB.` };
  const special = new Map<string, string>();
  const content = new Map<string, { base64: string; path: string; type: string }>();
  const manifest: Record<string, { hash: string; size: number }> = {};
  const bytesOf = new Map<string, Uint8Array>();
  for (const [index, item] of files.entries()) {
    onProgress(`Reading ${index + 1} of ${files.length}: ${item.path}`);
    if (item.path === "/_headers" || item.path === "/_redirects") {
      special.set(item.path, await item.file.text());
      continue;
    }
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    const text = base64(bytes);
    const hash = await assetHash(text, item.path);
    manifest[item.path] = { hash, size: bytes.length };
    bytesOf.set(item.path, bytes);
    content.set(hash, { base64: text, path: item.path, type: contentType(item.path) });
  }
  if (Object.keys(manifest).length === 0) return { error: "The folder has no files to publish." };
  const plan = await callApi<{ deployId: string; card: string; address: string; updated: boolean }>(
    "POST",
    "/api/sites/plan",
    "card" in target
      ? { card: target.card }
      : { folder: target.folder, ...(target.at ? { x: target.at.x, y: target.at.y } : {}) },
  );
  if ("error" in plan) return plan;
  const sent = await sendPlanned(plan.deployId, manifest, content, bytesOf, special, onProgress);
  if (sent) {
    // The deploy row and a new site's name do not wait until the plan expires.
    await post(
      "/api/sites/cancel",
      { "content-type": "application/json" },
      JSON.stringify({ deployId: plan.deployId }),
    );
    return sent;
  }
  return { card: plan.card, address: plan.address, updated: plan.updated };
}

/** The steps after the plan: the files, then the finish. Null when the site is published. */
async function sendPlanned(
  deployId: string,
  manifest: Record<string, { hash: string; size: number }>,
  content: ReadonlyMap<string, { base64: string; path: string; type: string }>,
  bytesOf: ReadonlyMap<string, Uint8Array>,
  special: ReadonlyMap<string, string>,
  onProgress: (text: string) => void,
): Promise<{ error: string } | null> {
  const assets = await callApi<{ buckets: Array<Array<string>> }>("POST", "/api/sites/assets", {
    deployId,
    manifest,
  });
  if ("error" in assets) return assets;
  // Cloudflare asks only for the files that it does not have yet.
  const wanted = assets.buckets.flat();
  let sent = 0;
  for (const bucket of assets.buckets) {
    let part: Array<string> = [];
    let size = 0;
    const send = async () => {
      if (part.length === 0) return null;
      const form = new FormData();
      for (const hash of part) {
        const file = content.get(hash);
        if (!file) return { error: `Cloudflare asked for an unknown file ${hash}.` };
        form.append(hash, new Blob([file.base64], { type: file.type }), hash);
      }
      onProgress(`Uploading ${sent + part.length} of ${wanted.length} files`);
      const answer = await post("/api/sites/upload", { "x-kitshn-deploy": deployId }, form);
      sent += part.length;
      part = [];
      size = 0;
      return "error" in answer ? answer : null;
    };
    for (const hash of bucket) {
      const length = content.get(hash)?.base64.length ?? 0;
      if (size + length > PART_BYTES) {
        const failed = await send();
        if (failed) return failed;
      }
      part.push(hash);
      size += length;
    }
    const failed = await send();
    if (failed) return failed;
  }
  onProgress("Publishing the site");
  const { icon } = await pickSiteIcon((path) => bytesOf.get(path) ?? null);
  const finishBody = JSON.stringify({
    deployId,
    icon: icon ? base64(icon.bytes) : null,
    headers: special.get("/_headers") ?? null,
    redirects: special.get("/_redirects") ?? null,
  });
  // A 503 says that the Access application of the new address is not made yet; it comes in a few seconds.
  for (let attempt = 1; ; attempt++) {
    const finish = await post("/api/sites/finish", { "content-type": "application/json" }, finishBody);
    if (!("error" in finish)) return null;
    if (finish.status !== 503 || attempt === 5) return finish;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/** A POST whose failure keeps its status, so the caller can tell "try again" from a refusal. */
async function post(
  path: string,
  headers: Record<string, string>,
  body: BodyInit,
): Promise<object | { error: string; status: number }> {
  let response: Response;
  try {
    response = await fetch(path, { method: "POST", headers, body });
  } catch (error) {
    return { error: `kitshn is not reachable: ${String(error)}`, status: 0 };
  }
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok || data === null)
    return { error: data?.error ?? `kitshn answered ${response.status}.`, status: response.status };
  return data;
}
