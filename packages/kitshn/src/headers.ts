/** Cloudflare's limits of a `_headers` file ([headers](https://developers.cloudflare.com/workers/static-assets/headers/)). */
const MAX_RULES = 100;
const MAX_LINE = 2000;

/**
 * K-805: warnings for a `_headers` file over Cloudflare's limits, which then ignores the rest. A rule starts at a
 * line without indent; `#` starts a comment.
 */
export function headersWarnings(text: string): Array<string> {
  const lines = text.split("\n");
  const rules = lines.filter((line) => line.trim() !== "" && !line.startsWith(" ") && !line.startsWith("\t") && !line.startsWith("#"));
  const long = lines.flatMap((line, index) => (line.length > MAX_LINE ? [index + 1] : []));
  return [
    ...(rules.length > MAX_RULES ? [`_headers has ${rules.length} rules; Cloudflare reads only the first ${MAX_RULES}.`] : []),
    ...long.map((line) => `_headers line ${line} is longer than ${MAX_LINE} characters; Cloudflare ignores it.`),
  ];
}
