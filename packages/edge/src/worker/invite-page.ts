// K-1601, K-720: the page of a device invite link, `kit.<zone>/join/device#code=<code>`. The code stays in the
// fragment, so it never reaches kitshn; the script reads it and fills the links of each declared client app.
import type { ProviderClient } from "@kitshn/local";
import { INVITE_URL_SLOT } from "../core/invite.ts";
import { escapeHtml } from "../core/html.ts";

export function invitePage(clients: ReadonlyArray<ProviderClient>, nonce: string): string {
  const apps = clients
    .map(
      (client) =>
        `<section class="app"><a class="button" data-open="${escapeHtml(client.open)}" href="#">Open in ${escapeHtml(client.name)}</a>${
          client.install.length > 0
            ? `<p class="note">Not installed? ${client.install
                .map(
                  (link) =>
                    `<a href="${escapeHtml(link.url)}" rel="noreferrer">${escapeHtml(link.label)}</a>`,
                )
                .join(" · ")}</p>`
            : ""
        }</section>`,
    )
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>kitshn device invite</title>
<style>
:root { color-scheme: light dark; --ink: #111; --paper: #fffdf6; }
@media (prefers-color-scheme: dark) { :root { --ink: #f5f3ea; --paper: #17161c; } }
body { font: 16px/1.5 system-ui, sans-serif; background: var(--paper); color: var(--ink); margin: 0; padding: 24px; }
main { max-width: 560px; margin: 0 auto; }
h1 { font-size: 28px; margin: 0 0 8px; }
section { border: 2px solid var(--ink); box-shadow: 4px 4px 0 var(--ink); padding: 16px; margin: 16px 0; }
.button, button { display: inline-block; font: inherit; font-weight: 700; text-decoration: none; border: 2px solid var(--ink); background: #facc15; color: #111; padding: 8px 14px; cursor: pointer; box-shadow: 3px 3px 0 var(--ink); }
button.quiet { background: transparent; color: var(--ink); box-shadow: none; padding: 4px 10px; }
a { color: inherit; }
code { font-size: 15px; font-weight: 700; overflow-wrap: anywhere; }
.note { opacity: .75; font-size: 14px; }
.error { color: #dc2626; font-weight: 700; }
ol { padding-left: 20px; }
</style></head>
<body><main>
<h1>Add this device to kitshn</h1>
<p class="note">This invite works once and expires 15 minutes after the owner made it.</p>
<p class="error" id="missing" hidden>This link has no invite code. Ask the owner for a new invite.</p>
${apps}
<section><div><strong>Invite link</strong></div><p><code id="link"></code></p><button class="quiet" id="copy">Copy invite link</button>
<p class="note">Code: <code id="code"></code></p></section>
<section><div><strong>Another app</strong></div><ol>
<li>Copy the invite link.</li>
<li>Open the app and find its "add server" or "new connection" field.</li>
<li>Paste the link there.</li></ol></section>
<noscript><p class="error">Turn on JavaScript to see the invite link.</p></noscript>
</main>
<script nonce="${nonce}">
const code = new URLSearchParams(location.hash.slice(1)).get("code") || "";
const link = location.origin + "/join/device#code=" + code;
const valid = code.length === 32 && [...code].every((char) => "0123456789abcdef".includes(char));
document.getElementById("missing").hidden = valid;
document.getElementById("link").textContent = valid ? link : "";
document.getElementById("code").textContent = code;
for (const open of document.querySelectorAll("a[data-open]"))
  if (valid) open.href = open.dataset.open.split(${JSON.stringify(INVITE_URL_SLOT)}).join(encodeURIComponent(link));
  else open.removeAttribute("href");
document.getElementById("copy").addEventListener("click", async (event) => {
  await navigator.clipboard.writeText(link);
  event.target.textContent = "Copied";
});
</script></body></html>`;
}

export function invitePageHeaders(nonce: string) {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline'",
      "frame-ancestors 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ].join("; "),
  };
}
