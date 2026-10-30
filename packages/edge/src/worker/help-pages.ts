// K-1132: the public help pages in the kitshn look: "What is this login?" and the page that Access sends a refused
// visitor to. Neither runs a script; both name no person and no email of the owner.
import { escapeHtml } from "../core/html.ts";

/** K-1132: the tick3d look of kitshn's own pages, the same tokens as the login pages (K-1130). */
export const PAGE_STYLE = `:root { color-scheme: light; --canvas: #E4E7FF; --dots: #00000026; --surface: #FFFFFF; --ink: #000000;
  --muted: #3D3D5C; --border: #000000; --shadow-ink: #000000; --select: #FFE14D; --pink: #FF9EB0; --accent: #6C5CE7;
  --sans: "Bricolage Grotesque", system-ui, sans-serif; --mono: "JetBrains Mono", ui-monospace, monospace; }
@media (prefers-color-scheme: dark) {
  :root { color-scheme: dark; --canvas: #15122B; --dots: #F3F0FF22; --surface: #262147; --ink: #F3F0FF;
    --muted: #BDB6E6; --border: #F3F0FF; --shadow-ink: #B9A8FF; --select: #6C5CE7; }
}
* { box-sizing: border-box; }
html { font-size: 18px; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; font: 1rem/1.5 var(--sans);
  color: var(--ink); background-color: var(--canvas); background-size: 16px 16px;
  background-image: radial-gradient(var(--dots) 1.2px, transparent 1.2px); }
main { width: min(32rem, 100%); padding: 24px; background: var(--surface); border: 2px solid var(--border);
  border-radius: 0.25rem; box-shadow: 4px 4px 0 0 var(--shadow-ink); }
.sticker { display: inline-block; margin-right: 6px; padding: 0 6px; font-size: 0.65rem; font-weight: 800;
  letter-spacing: 0.04em; text-transform: uppercase; color: #000000; background: var(--pink);
  border: 2px solid var(--shadow-ink); border-radius: 4px; box-shadow: 2px 2px 0 0 var(--shadow-ink); transform: rotate(-3deg); }
code { font-family: var(--mono); font-size: 0.85em; padding: 0 2px; overflow-wrap: anywhere;
  background: linear-gradient(transparent 35%, var(--select) 35%, var(--select) 88%, transparent 88%); }
h1 { margin: 16px 0 4px; font-size: 1.6rem; font-weight: 800; letter-spacing: -0.01em; }
p, li { color: var(--muted); }
a { color: inherit; font-weight: 700; }
.button { display: inline-block; margin: 4px 8px 4px 0; padding: 6px 14px; font: 800 0.9rem var(--sans); color: #FFFFFF;
  text-decoration: none; background: var(--accent); border: 2px solid var(--border); border-radius: 0.25rem;
  box-shadow: 3px 3px 0 0 var(--shadow-ink); cursor: pointer; }
.button.quiet { color: var(--ink); background: var(--surface); }
form { display: inline; }`;

const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;

/** K-1132: no script, no frame, a form only to this host. */
export const helpPageHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
};

/** K-1132: "What is this login?", linked from each kitshn login page (K-1130). */
export function loginHelpPage(zone: string): string {
  return page(
    "What is this login?",
    `<span class="sticker">help</span><code>${escapeHtml(zone)}</code>
<h1>What is this login?</h1>
<p>The owner of <code>${escapeHtml(zone)}</code> shares some pages and apps with people they pick. The login checks that you are one of them.</p>
<ol>
<li>Type the email address that the owner knows. You get a one-time code by email.</li>
<li>Type the code. Some places also ask for a passkey.</li>
<li>When the owner shared the place with that email, it opens.</li>
</ol>
<p>The login keeps no password. To ask for access, ask the owner, or log in and use "Ask for access" when the place refuses you.</p>`,
  );
}

/**
 * K-1132: the address that a refused visitor wanted, from Access's `original_url` (host and path, which the visitor can
 * change), as an https URL on the zone; null for anything else, so no link leads off the zone.
 */
export function wantedAddress(original: string, zone: string): string | null {
  if (original === "") return null;
  const url = URL.parse(original.includes("://") ? original : `https://${original}`);
  if (!url || url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  return url.hostname === zone || url.hostname.endsWith(`.${zone}`) ? url.href : null;
}

interface Refusal {
  readonly zone: string;
  /** The card name, or null for an application that kitshn does not know. */
  readonly card: string | null;
  /** An https URL from wantedAddress, or null. */
  readonly wanted: string | null;
  readonly host: string;
  readonly teamDomain: string;
}

const refusalText = (input: Refusal) => {
  const what = input.card === null ? "this place" : escapeHtml(input.card);
  return `<span class="sticker">no access</span><code>${escapeHtml(input.wanted ?? input.zone)}</code>
<h1>Your email is not on the list for ${what}</h1>
<p>The owner of <code>${escapeHtml(input.zone)}</code> did not share ${what} with the email that you used.</p>`;
};

const refusalLinks = (input: Refusal) =>
  `<a class="button quiet" href="https://${escapeHtml(input.teamDomain)}/cdn-cgi/access/logout">Log out to use another email</a>${
    input.wanted ? `<a class="button quiet" href="${escapeHtml(input.wanted)}">Open it again</a>` : ""
  }</p>
<p><a href="https://${escapeHtml(input.host)}/public/help/login">What is this login?</a></p>`;

/**
 * K-1132: the page of a visitor whom no circle knows. It has no "Ask for access": only people whom a circle lets in
 * may log in to `/ask`, so a stranger never takes a seat (K-111).
 */
export function deniedPage(input: Refusal): string {
  return page(
    "No access",
    `${refusalText(input)}
<p>Ask the person who sent you this link to add your email.</p>
<p>${refusalLinks(input)}`,
  );
}

/** K-1132: the refusal on `/ask`, for a person whom some circle knows, with "Ask for access"; and its answer. */
export function askPage(
  input:
    | (Refusal & { readonly step: "confirm"; readonly email: string; readonly kid: string })
    | { readonly step: "done" | "refused"; readonly text: string; readonly zone: string },
): string {
  if (input.step !== "confirm")
    return page(
      "Ask for access",
      `<span class="sticker">${input.step === "done" ? "asked" : "not asked"}</span><code>${escapeHtml(input.zone)}</code>
<h1>${input.step === "done" ? "The owner got your ask" : "kitshn did not send the ask"}</h1>
<p>${escapeHtml(input.text)}</p>`,
    );
  return page(
    "No access",
    `${refusalText(input)}
<p>You are logged in as <code>${escapeHtml(input.email)}</code>. "Ask for access" sends this email and the name of the place to the owner's Inbox. Nothing else goes with it.</p>
<p><form method="post"><input type="hidden" name="kid" value="${escapeHtml(input.kid)}"><button class="button" type="submit">Ask for access</button></form>${refusalLinks(input)}`,
  );
}
