// K-524, K-1114: the card icon of a Compose app or a live site, read from the app itself through its own target.
import { type SiteIcon, pickSiteIcon } from "kitshn/icon";
import { isSocketFile } from "./sites.ts";

/** Enough for the entry page and the manifest; the picker refuses an icon over its own limit (K-1113). */
const READ_LIMIT = 256 * 1024;
/** The entry page, the manifest and a few candidates; a page with many icon links cannot keep the daemon busy. */
const READS_PER_SITE = 8;
const READ_TIMEOUT_MS = 2000;
/** At most this many sites per site check (every 10 seconds), so a machine with many apps never stalls. */
export const ICON_SITES_PER_PASS = 3;
const HOUR_MS = 60 * 60_000;
/** A dev server that restarts often is read again only after this time. */
const AGAIN_MS = 60_000;

/**
 * One GET on the target of the site: a Unix socket or a port on localhost. A redirect, an answer that is not
 * 200 and a body over the limit all count as no file.
 */
export async function readTarget(target: string, path: string): Promise<Uint8Array | null> {
  const unix = target.startsWith("unix:") ? target.slice("unix:".length) : null;
  if (unix !== null && !isSocketFile(unix)) return null;
  const url = `${unix === null ? target : "http://localhost"}${encodeURI(path)}`;
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    ...(unix === null ? {} : { unix }),
  }).catch(() => null);
  if (response === null) return null;
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel();
    return null;
  }
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > READ_LIMIT) {
        await response.body.cancel();
        return null;
      }
      chunks.push(chunk);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}

/** K-1114: the icon of the app at the target, in the order of K-1112 with `/` as the entry page. */
export async function targetIcon(target: string): Promise<SiteIcon | null> {
  let reads = 0;
  const { icon } = await pickSiteIcon((path) => (++reads > READS_PER_SITE ? null : readTarget(target, path)), "/");
  return icon;
}

/** What the daemon remembers of one site during one connection. */
export interface IconMemory {
  readonly readAt: number;
  /** False after the site went down, until the next read, so a site that comes up is read again. */
  readonly up: boolean;
  /** The hash that the daemon last sent, and when; null hash means "no icon". */
  readonly sent: { readonly hash: string | null; readonly at: number } | null;
}

/**
 * K-1114: the up sites to read now: never read in this connection, read more than an hour ago, or just come up
 * (at most once a minute). At most `ICON_SITES_PER_PASS`, the oldest read first.
 */
export function iconsDue(
  sites: ReadonlyArray<{ readonly name: string; readonly up: boolean }>,
  memory: ReadonlyMap<string, IconMemory>,
  now: number,
): Array<string> {
  return sites
    .filter((site) => {
      const known = memory.get(site.name);
      if (!site.up) return false;
      if (!known) return true;
      return now - known.readAt > HOUR_MS || (!known.up && now - known.readAt > AGAIN_MS);
    })
    .sort((a, b) => (memory.get(a.name)?.readAt ?? 0) - (memory.get(b.name)?.readAt ?? 0))
    .slice(0, ICON_SITES_PER_PASS)
    .map((site) => site.name);
}

/** K-1114: send the icon when it changed, or again after an hour, in case kitshn held back a change. */
export const iconToSend = (sent: IconMemory["sent"], hash: string | null, now: number) =>
  sent === null || sent.hash !== hash || now - sent.at > HOUR_MS;
