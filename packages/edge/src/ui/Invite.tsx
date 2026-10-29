import { useState } from "preact/hooks";
import { encode } from "uqr";
import { callApi } from "./store.ts";

/** K-1601: a waiting invite of a phone or desktop app, as `POST /api/devices/invites` answers it. */
export interface DeviceInvite {
  readonly tokenId: string;
  readonly clientId: string;
  readonly name: string;
  readonly link: string;
  readonly expiresAt: number;
}

/** The fork Android app in Obtainium: prereleases, the fallback to older releases and the APK filter of K-1601. */
const OBTAINIUM_ADD_URL = `https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/${encodeURIComponent(
  JSON.stringify({
    id: "com.yardenzamir.t3code",
    url: "https://github.com/Yarden-zamir/t3code",
    author: "Yarden-zamir",
    name: "T3 Code fork",
    // Obtainium reads `additionalSettings` as a JSON string, not as an object.
    additionalSettings: JSON.stringify({
      includePrereleases: true,
      fallbackToOlderReleases: true,
      apkFilterRegEx: "android\\.apk$",
    }),
  }),
)}`;

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
        <p class="help">
          Scan this in the T3 Code app on the phone, or paste the link in the desktop app. It works once,
          until {until}.
        </p>
        <div class="qr-box">
          <QrCode text={invite.link} label={`QR code of the invite of ${invite.name}`} />
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
          <a
            class="btn"
            href={OBTAINIUM_ADD_URL}
            target="_blank"
            rel="noreferrer"
            data-tip="Add the T3 Code Android app with Obtainium, with its prereleases."
          >
            Add with Obtainium
          </a>
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
