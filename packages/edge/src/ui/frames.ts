import { contentType, showsInline } from "kitshn/media";
import type { Resource } from "../core/model.ts";

/** The card kinds whose address shows a site or a page in a frame (K-520). */
export const FRAMED_KINDS: ReadonlySet<Resource["kind"]> = new Set([
  "site.static",
  "site.worker",
  "site.compose",
  "site.live",
  "page",
]);

/**
 * K-520: the sandbox of a frame of `address`, or null when it must not be framed. A site gets its own origin
 * with scripts, which is safe only off the admin host; pages and files carry their own sandbox from the Worker,
 * so they never get `allow-same-origin` here.
 */
export function frameSandbox(address: string, adminHost: string, zone: string): string | null {
  const host = address.split("/")[0] ?? "";
  if (host === "" || host === adminHost) return null;
  if (host === `pages.${zone}` || host === `files.${zone}`) return "allow-scripts";
  return "allow-scripts allow-same-origin allow-forms";
}

/** K-520: whether a card offers the preview arrow. A file only when a browser shows its type instead of a download. */
export function peekable(resource: Resource): boolean {
  if (!resource.addresses[0]) return false;
  if (FRAMED_KINDS.has(resource.kind)) return true;
  if (resource.kind !== "file") return false;
  const name = decodeURIComponent(resource.addresses[0].split("/").at(-1) ?? "");
  return showsInline(contentType(name));
}
