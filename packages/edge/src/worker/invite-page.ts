// K-1601, K-720: the page of a device invite link, `kit.<zone>/join/device#code=<code>`. The code stays in the
// fragment, so it never reaches kitshn; the script reads it and fills the links of each declared client app.
import type { ProviderClient } from "@kitshn/local";
import { INVITE_URL_SLOT } from "../core/invite.ts";
import { escapeHtml } from "../core/html.ts";
import { PAGE_STYLE } from "./help-pages.ts";

export function invitePage(clients: ReadonlyArray<ProviderClient>, nonce: string): string {
  const apps = clients
    .map(
      (client) =>
        `<section class="app" data-client="${escapeHtml(client.id)}"><a class="button" data-open="${escapeHtml(client.open)}" href="#">Open in ${escapeHtml(client.name)}</a>${
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
<style>${PAGE_STYLE}
body { place-items: start center; }
section { margin: 16px 0; padding: 16px; border: 2px solid var(--border); border-radius: 0.25rem; box-shadow: 3px 3px 0 0 var(--shadow-ink); }
#others section { margin: 8px 0; padding: 0; border: 0; box-shadow: none; }
#others .button { color: var(--ink); background: var(--surface); }
button.quiet { color: var(--ink); background: var(--surface); }
.note { font-size: 0.8rem; }
.error { color: #DC2626; font-weight: 800; }
</style></head>
<body><main>
<h1>Add this device to kitshn</h1>
<p class="note">This invite works once and expires 15 minutes after the owner made it.</p>
<p class="error" id="missing" hidden>This link has no invite code. Ask the owner for a new invite.</p>
<div id="main">${apps}</div>
<section><div><strong>Another app</strong></div><div id="others"></div><ol>
<li>Copy the invite link below.</li>
<li>Open the app and find its "add server" or "new connection" field.</li>
<li>Paste the link there.</li></ol></section>
<section><div><strong>Invite link</strong></div><p><code id="link"></code></p><button class="button quiet" id="copy">Copy invite link</button>
<p class="note">Code: <code id="code"></code></p></section>
<noscript><p class="error">Turn on JavaScript to see the invite link.</p></noscript>
</main>
<script nonce="${nonce}">
const fragment = new URLSearchParams(location.hash.slice(1));
const code = fragment.get("code") || "";
// K-1601: one main button, for the app that the owner picked (the "client" of the link), else the first one.
const apps = [...document.querySelectorAll("#main > section.app")];
const picked = apps.find((app) => app.dataset.client === fragment.get("client")) || apps[0];
for (const app of apps) if (app !== picked) document.getElementById("others").append(app);
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
