/**
 * The site icon of a static site (K-1112, K-1113). The CLI picks it from the built files, because only Actions
 * has their bytes; the Worker gets the manifest of hashes only. The Worker checks it again with `iconType`.
 */

/** K-1113: the largest icon that kitshn keeps. */
export const ICON_LIMIT = 100 * 1024;

export const ICON_TYPES = [
  "image/png",
  "image/x-icon",
  "image/gif",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
] as const;
export type IconType = (typeof ICON_TYPES)[number];

const startsWith = (bytes: Uint8Array, prefix: ReadonlyArray<number>, at = 0) =>
  prefix.every((byte, index) => bytes[at + index] === byte);

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** The image type of the bytes from their first bytes, or null when they are no image that kitshn keeps. */
export function iconType(bytes: Uint8Array): IconType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (startsWith(bytes, ascii("GIF8"))) return "image/gif";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  // An SVG is text: an optional XML prolog and comments, then the svg element.
  const head = new TextDecoder().decode(bytes.subarray(0, 1024)).trimStart().toLowerCase();
  if (
    (head.startsWith("<svg") || head.startsWith("<?xml") || head.startsWith("<!--")) &&
    head.includes("<svg")
  )
    return "image/svg+xml";
  return null;
}

/**
 * The attributes of each tag with this name, lower-case names. A `>` inside a quoted value does not end the tag,
 * and tags inside `<!-- -->` do not count. Enough for `<link>`; not a full HTML parser.
 */
function tags(html: string, name: string, limit = Number.POSITIVE_INFINITY): Array<Map<string, string>> {
  const found: Array<Map<string, string>> = [];
  const lower = html.toLowerCase();
  // One pass from left to right: each search starts at `from`, so a page with many tags stays linear.
  let from = 0;
  let comment = lower.indexOf("<!--");
  for (let at = lower.indexOf(`<${name}`); at !== -1; at = lower.indexOf(`<${name}`, from)) {
    if (comment !== -1 && comment < at) {
      const close = lower.indexOf("-->", comment + 4);
      if (close === -1) break;
      from = close + 3;
      comment = lower.indexOf("<!--", from);
      continue;
    }
    const end = tagEnd(html, at + name.length + 1);
    if (end === -1) break;
    const after = lower[at + name.length + 1] ?? "";
    if (after === " " || after === "\t" || after === "\n" || after === "\r" || after === "/")
      found.push(attributes(html.slice(at + name.length + 1, end)));
    if (found.length >= limit) break;
    from = end;
    if (comment !== -1 && comment < from) comment = lower.indexOf("<!--", from);
  }
  return found;
}

/** The index of the `>` that ends a tag, outside quoted values, or -1. */
function tagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let index = from; index < html.length; index++) {
    const char = html[index];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return index;
  }
  return -1;
}

/** The character references that hrefs use most; other references stay as they are. */
const entities = (value: string) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

function attributes(text: string): Map<string, string> {
  const result = new Map<string, string>();
  let index = 0;
  const space = () => {
    while (index < text.length && " \t\n\r/".includes(text[index] ?? "")) index++;
  };
  while (index < text.length) {
    space();
    let key = "";
    while (index < text.length && !" \t\n\r/=".includes(text[index] ?? "")) key += text[index++];
    space();
    let value = "";
    if (text[index] === "=") {
      index++;
      space();
      const quote = text[index];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, index + 1);
        value = text.slice(index + 1, close === -1 ? text.length : close);
        index = close === -1 ? text.length : close + 1;
      } else {
        while (index < text.length && !" \t\n\r".includes(text[index] ?? "")) value += text[index++];
      }
    }
    if (key) result.set(key.toLowerCase(), entities(value));
  }
  return result;
}

const SITE = "https://site.invalid";

/** The manifest path of a link on the site, or null for another host or no file. Query and fragment drop. */
function sitePath(href: string, from: string): string | null {
  if (!href.trim()) return null;
  const url = new URL(href.trim(), `${SITE}${from}`);
  if (url.origin !== SITE) return null;
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    // Broken percent-encoding names no file of the site.
    return null;
  }
}

const relHas = (link: Map<string, string>, token: string) =>
  (link.get("rel") ?? "")
    .toLowerCase()
    .replaceAll("\t", " ")
    .replaceAll("\n", " ")
    .split(" ")
    .includes(token);

/** One candidate and why it counts, for the deploy log. */
export interface IconCandidate {
  readonly path: string;
  readonly source: string;
}

/** Reads one file of a site by its path, or null when the site has no such file. */
export type SiteReader = (path: string) => Uint8Array | null | Promise<Uint8Array | null>;

/**
 * K-1112: the icon candidates in order: each `<link rel="icon">` of the entry page, then /favicon.ico, then each
 * icon of the web manifest that the entry page links. The entry page is /index.html of built files, or / of a
 * running app. Known limit: `<base href>` is ignored; revisit when a site with a base element shows the wrong icon.
 */
async function iconCandidates(
  readText: (path: string) => Promise<string | null>,
  entry: string,
): Promise<Array<IconCandidate>> {
  const html = await readText(entry);
  const links = html === null ? [] : tags(html, "link");
  const candidates: Array<IconCandidate> = [];
  for (const link of links.filter((item) => relHas(item, "icon"))) {
    const path = sitePath(link.get("href") ?? "", entry);
    if (path) candidates.push({ path, source: `<link rel="icon"> of ${entry}` });
  }
  candidates.push({ path: "/favicon.ico", source: "/favicon.ico" });
  const manifestLink = links.find((item) => relHas(item, "manifest"));
  const manifestPath = manifestLink ? sitePath(manifestLink.get("href") ?? "", entry) : null;
  const manifestText = manifestPath ? await readText(manifestPath) : null;
  if (manifestPath && manifestText !== null) {
    let icons: unknown = null;
    try {
      icons = (JSON.parse(manifestText) as { icons?: unknown } | null)?.icons ?? null;
    } catch {
      icons = null;
    }
    for (const icon of Array.isArray(icons) ? icons : []) {
      const src = (icon as { src?: unknown } | null)?.src;
      const path = typeof src === "string" ? sitePath(src, manifestPath) : null;
      if (path) candidates.push({ path, source: `the web manifest ${manifestPath}` });
    }
  }
  return candidates;
}

/** K-1115: a page reads at most this many `<link>` tags for its icon. */
const PAGE_LINK_LIMIT = 64;

/**
 * K-1115: the first `<link rel="icon">` of a page whose href is a `data:` URL, as bytes; null when there is none or
 * it does not decode. A page is one file, so a link to a path names nothing kitshn has.
 */
export function pageDataIcon(html: string): Uint8Array | null {
  // A page links its icon near the top; the limit keeps a page with thousands of links within the CPU budget.
  const href = tags(html, "link", PAGE_LINK_LIMIT)
    .filter((item) => relHas(item, "icon"))
    .map((item) => (item.get("href") ?? "").trim())
    .find((value) => value.toLowerCase().startsWith("data:"));
  const comma = href?.indexOf(",") ?? -1;
  if (href === undefined || comma === -1) return null;
  const data = href.slice(comma + 1);
  try {
    if (!href.slice("data:".length, comma).toLowerCase().endsWith(";base64"))
      return new TextEncoder().encode(decodeURIComponent(data));
    // atob skips ASCII whitespace itself; a plain loop is far cheaper than Uint8Array.from with a callback.
    const text = atob(data);
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

export interface SiteIcon {
  readonly path: string;
  readonly type: IconType;
  readonly bytes: Uint8Array;
}

/**
 * K-1112, K-1113: the first candidate that exists, is an image and fits the limit. `notes` says why each
 * earlier candidate that exists did not win, for the deploy log; null `icon` means the card shows its kind icon.
 */
export async function pickSiteIcon(
  read: SiteReader,
  entry = "/index.html",
): Promise<{ readonly icon: SiteIcon | null; readonly notes: ReadonlyArray<string> }> {
  const text = async (path: string) => {
    const bytes = await read(path);
    return bytes === null ? null : new TextDecoder().decode(bytes);
  };
  const notes: Array<string> = [];
  for (const candidate of await iconCandidates(text, entry)) {
    const bytes = await read(candidate.path);
    if (bytes === null) {
      if (candidate.path !== "/favicon.ico")
        notes.push(`${candidate.path} from ${candidate.source} is missing.`);
      continue;
    }
    if (bytes.length > ICON_LIMIT) {
      notes.push(`${candidate.path} is larger than ${ICON_LIMIT / 1024} KB, the limit of a card icon.`);
      continue;
    }
    const type = iconType(bytes);
    if (type === null) {
      notes.push(`${candidate.path} is not a PNG, ICO, GIF, JPEG, WebP or SVG image.`);
      continue;
    }
    return { icon: { path: candidate.path, type, bytes }, notes };
  }
  return { icon: null, notes };
}
