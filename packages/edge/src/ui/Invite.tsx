import { useId, useRef, useState } from "preact/hooks";
import { encode } from "uqr";
import { type InviteClient, openLink } from "../core/invite.ts";
import { callApi } from "./store.ts";

/** K-1601: a waiting invite of a phone or desktop app, as `POST /api/devices/invites` answers it. */
export interface DeviceInvite {
  readonly tokenId: string;
  readonly clientId: string;
  readonly name: string;
  readonly link: string;
  readonly expiresAt: number;
  /** K-720: the client apps that the providers declare, with their machines; each gets its own QR code. */
  readonly clients: ReadonlyArray<InviteClient>;
  /** K-720: every machine that declares clients declares the same ones. */
  readonly agree: boolean;
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
  // K-720: the last tab is the plain https link. The first app shows first only when the machines agree on the apps,
  // so one machine cannot put its own app in front of the owner.
  const [tab, setTab] = useState(invite.agree ? 0 : invite.clients.length);
  const client = invite.clients[tab];
  const id = useId();
  const tabs = useRef<HTMLDivElement>(null);
  const labels = [...invite.clients.map((each) => each.name), "Link"];
  const pick = (index: number) => {
    const next = (index + labels.length) % labels.length;
    setTab(next);
    tabs.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  };
  const qrText = client ? openLink(client.open, invite.link) : invite.link;
  // K-1601: the link names the app of the open tab, so its page offers that app as the main button.
  // Only an app that every machine declares is on that page (K-720); for any other the page would pick another app.
  const link =
    client && invite.agree
      ? `${invite.link}${invite.link.includes("#") ? "&" : "#"}client=${encodeURIComponent(client.id)}`
      : invite.link;
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
        <div
          class="invite-tabs"
          role="tablist"
          aria-label="App"
          ref={tabs}
          onKeyDown={(event) => {
            const step = { ArrowRight: tab + 1, ArrowLeft: tab - 1, Home: 0, End: labels.length - 1 }[
              event.key
            ];
            if (step === undefined) return;
            event.preventDefault();
            pick(step);
          }}
        >
          {labels.map((label, index) => {
            const each = invite.clients[index];
            return (
              <button
                key={each ? `${each.provider}/${each.id}/${each.machines.join(",")}` : "link"}
                id={`${id}-tab-${index}`}
                type="button"
                role="tab"
                aria-selected={tab === index}
                aria-controls={`${id}-panel`}
                tabIndex={tab === index ? 0 : -1}
                data-tip={
                  each
                    ? `A QR code that opens ${label} with this invite. Declared by ${each.machines.join(", ")}.`
                    : "A QR code of the invite link. Its page offers each app, the link and the code."
                }
                onClick={() => setTab(index)}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`}>
          <p class="help">
            {client
              ? `Scan this with the phone camera to open ${client.name}. Declared by ${client.machines.join(", ")}.`
              : "Scan this with the phone camera, or paste the link into the app's add server field."}{" "}
            It works once, until {until}.
          </p>
          <div class="qr-box">
            <QrCode text={qrText} label={`QR code of the invite of ${invite.name}`} />
          </div>
        </div>
        <div class="secret">
          <code>{link}</code>
        </div>
        <div class="row">
          <button
            type="button"
            class="btn"
            data-tip="Copy the invite link to the clipboard."
            onClick={() => void navigator.clipboard.writeText(link)}
          >
            Copy link
          </button>
          {client?.install.map((link, index) => (
            <a
              key={`${index}-${link.url}`}
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
