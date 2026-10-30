import { useState } from "preact/hooks";
import { encode } from "uqr";
import type { ProviderClient } from "@kitshn/local";
import { openLink } from "../core/invite.ts";
import { callApi } from "./store.ts";

/** K-1601: a waiting invite of a phone or desktop app, as `POST /api/devices/invites` answers it. */
export interface DeviceInvite {
  readonly tokenId: string;
  readonly clientId: string;
  readonly name: string;
  readonly link: string;
  readonly expiresAt: number;
  /** K-720: the client apps that the providers declare; each gets its own QR code. */
  readonly clients: ReadonlyArray<ProviderClient>;
}

/** The QR code of a text as one SVG path, with a quiet zone of 2 modules. It stays black on white in dark mode. */
function QrCode(props: { text: string; label: string }) {
  const { data, size } = encode(props.text, { border: 2 });
  const modules = data.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : [])));
  return (
    <svg
      class="qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={props.label}
      shape-rendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={modules.join("")} fill="#000" />
    </svg>
  );
}

/** K-1601: the invite of one app: its QR code and link. The code works once; kitshn cannot show it again. */
export function InviteDialog(props: { invite: DeviceInvite; onClose: () => void }) {
  const { invite } = props;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // K-720: the first declared app by default; the last tab is the plain https link, for any other app.
  const [tab, setTab] = useState(0);
  const client = invite.clients[tab];
  const qrText = client ? openLink(client.open, invite.link) : invite.link;
  const until = new Date(invite.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    const result = await callApi<{ ok: true }>(
      "DELETE",
      `/api/devices/invites/${encodeURIComponent(invite.tokenId)}`,
    );
    setBusy(false);
    if ("error" in result) return setError(result.error);
    props.onClose();
  };
  return (
    <div class="scrim">
      <div class="dialog invite" role="dialog" aria-label={`Invite of ${invite.name}`}>
        <div class="row">
          <span
            class="sticker"
            data-tip="The code works once. kitshn cannot show it again after this dialog."
          >
            one use
          </span>
          <b>{invite.name}</b>
        </div>
        <div class="seg" role="tablist" aria-label="App">
          {[...invite.clients.map((each) => each.name), "Link"].map((label, index) => (
            <button
              key={label}
              type="button"
              role="tab"
              aria-pressed={tab === index}
              aria-selected={tab === index}
              data-tip={
                index < invite.clients.length
                  ? `A QR code that opens ${label} with this invite.`
                  : "A QR code of the invite link. Its page offers each app, the link and the code."
              }
              onClick={() => setTab(index)}
            >
              {label}
            </button>
          ))}
        </div>
        <p class="help">
          {client
            ? `Scan this with the phone camera to open ${client.name}, or open the link on the desktop.`
            : "Scan this with the phone camera, or paste the link into the app's add server field."}{" "}
          It works once, until {until}.
        </p>
        <div class="qr-box">
          <QrCode text={qrText} label={`QR code of the invite of ${invite.name}`} />
        </div>
        <div class="secret">
          <code>{invite.link}</code>
        </div>
        <div class="row">
          <button
            type="button"
            class="btn"
            data-tip="Copy the invite link to the clipboard."
            onClick={() => void navigator.clipboard.writeText(invite.link)}
          >
            Copy link
          </button>
          {client?.install.map((link) => (
            <a
              key={link.url}
              class="btn"
              href={link.url}
              target="_blank"
              rel="noreferrer"
              data-tip={`Install ${client.name}: ${link.label}.`}
            >
              {link.label}
            </a>
          ))}
        </div>
        {error ? <p class="error">{error}</p> : null}
        <div class="row">
          <button
            type="button"
            class="btn"
            disabled={busy}
            data-tip="The code stops working. The device and its token stay."
            onClick={() => void cancel()}
          >
            Cancel invite
          </button>
          <button
            type="button"
            class="btn primary"
            data-tip="Close this dialog. The invite keeps working until it expires."
            onClick={props.onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
