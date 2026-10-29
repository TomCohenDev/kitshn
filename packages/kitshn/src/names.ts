/** K-1104, K-817: names that kitshn itself uses on its zone; no live site or extra address takes them. */
export const RESERVED_SITE_NAMES: ReadonlySet<string> = new Set(["pages", "files", "kit", "www"]);

/**
 * K-805, K-1129: a dot file or folder is never part of a site, from the CLI or the browser: `.git` holds the checkout
 * token, and `.env` holds secrets.
 */
export const isHiddenName = (name: string) => name.startsWith(".");

/** K-804: the key of the app of `defineApp`; it keeps the card ids and addresses of a repo with one app. */
export const DEFAULT_APP = "app";
