/** Cloudflare's limits of a `_headers` file ([headers](https://developers.cloudflare.com/workers/static-assets/headers/)). */
const MAX_RULES = 100;
const MAX_LINE = 2000;

/**
 * K-805: warnings for a `_headers` file over Cloudflare's limits, which then ignores the rest. A rule starts at a
 * line without indent; `#` starts a comment.
 */
export function headersWarnings(text: string): Array<string> {
  const lines = text.split("\n");
  const rules = lines.filter(
    (line) => line.trim() !== "" && !line.startsWith(" ") && !line.startsWith("\t") && !line.startsWith("#"),
  );
  const long = lines.flatMap((line, index) => (line.length > MAX_LINE ? [index + 1] : []));
  return [
    ...(rules.length > MAX_RULES
      ? [`_headers has ${rules.length} rules; Cloudflare reads only the first ${MAX_RULES}.`]
      : []),
    ...long.map(
      (line) => `_headers line ${line} is longer than ${MAX_LINE} characters; Cloudflare ignores it.`,
    ),
  ];
}

/** Cloudflare's limits of a `_redirects` file ([redirects](https://developers.cloudflare.com/workers/static-assets/redirects/)). */
const MAX_STATIC_REDIRECTS = 2000;
const MAX_DYNAMIC_REDIRECTS = 100;
const MAX_REDIRECT_LINE = 1000;

/**
 * K-805: warnings for a `_redirects` file over Cloudflare's limits. A rule is a line that is not empty and no `#`
 * comment; a rule with a splat `*` or a placeholder `:` in its source is dynamic.
 */
export function redirectsWarnings(text: string): Array<string> {
  const lines = text.split("\n");
  const rules = lines.map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  const dynamic = rules.filter((rule) => {
    const source = rule.split(" ")[0] ?? "";
    return source.includes("*") || source.includes(":");
  }).length;
  const long = lines.flatMap((line, index) => (line.length > MAX_REDIRECT_LINE ? [index + 1] : []));
  return [
    ...(rules.length - dynamic > MAX_STATIC_REDIRECTS
      ? [
          `_redirects has ${rules.length - dynamic} static rules; Cloudflare reads at most ${MAX_STATIC_REDIRECTS}.`,
        ]
      : []),
    ...(dynamic > MAX_DYNAMIC_REDIRECTS
      ? [`_redirects has ${dynamic} dynamic rules; Cloudflare reads at most ${MAX_DYNAMIC_REDIRECTS}.`]
      : []),
    ...long.map(
      (line) =>
        `_redirects line ${line} is longer than ${MAX_REDIRECT_LINE} characters; Cloudflare ignores it.`,
    ),
  ];
}
