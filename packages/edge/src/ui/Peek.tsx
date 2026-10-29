import { createPortal } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { type Resource, type State, activeShares, isPublicCircle } from "../core/model.ts";
import { frameSandbox } from "./frames.ts";

/** K-520: a card that opens without a login; any other card needs an Access session, which a frame cannot start. */
const opensForAnyone = (state: State, resource: Resource) =>
  activeShares(state, resource, Date.now()).some(
    (share) => isPublicCircle(share.circle) && share.circle.match === "any",
  );

const LOGIN_HELP = "Shows only after you log in. Open it in a new tab to log in.";

export type FramePhase = "loading" | "loaded" | "failed";

/**
 * A frame that has not loaded after this long shows "Preview not available". A browser fires no error for a frame,
 * and fires `load` for the error page of a refused one, so this catches only a page that hangs.
 */
const FRAME_GIVE_UP_MS = 20_000;

/**
 * K-520: a preview frame that shows a still "Loading preview" in its place until the page fires `load`, and
 * "Preview not available" with Open when it never does. The frame keeps loading behind it, and shows when it loads.
 * It loads at once, because it mounts only while shown, so the timer starts with the load. Callers key it by its
 * address, so a new address starts again from "Loading preview".
 */
export function LiveFrame(props: {
  url: string;
  label: string;
  sandbox: string;
  interact: boolean;
  /** A fixed phase that ignores the page, for the style guide (`/neo-brutalism`); the map never sets it. */
  still?: FramePhase;
}) {
  const [loadPhase, setPhase] = useState<FramePhase>("loading");
  const phase = props.still ?? loadPhase;
  useEffect(() => {
    const timer = setTimeout(() => setPhase((now) => (now === "loading" ? "failed" : now)), FRAME_GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <>
      <iframe
        src={props.url}
        aria-label={props.label}
        sandbox={props.sandbox}
        style={{
          pointerEvents: props.interact ? "auto" : "none",
          visibility: phase === "loaded" ? "visible" : "hidden",
        }}
        onLoad={() => setPhase("loaded")}
      />
      {phase === "loaded" ? null : (
        <div class="frame-state" role="status">
          {phase === "loading" ? (
            <span>Loading preview…</span>
          ) : (
            <>
              <span>Preview not available</span>
              <a
                class="btn"
                href={props.url}
                target="_blank"
                rel="noreferrer"
                data-tip="Open the address in a new tab."
              >
                Open
              </a>
            </>
          )}
        </div>
      )}
    </>
  );
}

/**
 * A live view of a site or page. A site behind Access shows only when this browser already has its Access
 * cookie: the Access login refuses to load in a frame, so "Open in new tab" logs in there.
 */
export function CardPreview(props: {
  resource: Resource;
  state: State;
  zone: string;
  onEnlarge?: () => void;
  /** A fixed phase of the frame, for the style guide (`/neo-brutalism`). */
  still?: FramePhase;
}) {
  const [interact, setInteract] = useState(false);
  const address = props.resource.addresses[0] ?? "";
  const sandbox = frameSandbox(address, location.hostname, props.zone);
  if (sandbox === null) return null;
  const url = `https://${address}`;
  return (
    <div class="preview-frame" onPointerDown={(event) => event.stopPropagation()}>
      <div class="thumb">
        <LiveFrame
          key={url}
          url={url}
          label={`Preview of ${address}`}
          sandbox={sandbox}
          interact={interact}
          {...(props.still ? { still: props.still } : {})}
        />
      </div>
      <div class="row">
        <button
          type="button"
          class="btn"
          data-tip={
            interact
              ? "Done: the preview takes no clicks again."
              : "Interact: the preview takes clicks and keys."
          }
          onClick={() => setInteract(!interact)}
        >
          {interact ? "Done" : "Interact"}
        </button>
        {props.onEnlarge ? (
          <button
            type="button"
            class="btn"
            data-tip="Show the preview large, over the map."
            onClick={props.onEnlarge}
          >
            Enlarge
          </button>
        ) : null}
        <a class="btn" href={url} target="_blank" rel="noreferrer" data-tip="Open the address in a new tab.">
          Open
        </a>
      </div>
      {opensForAnyone(props.state, props.resource) ? null : <div class="help">{LOGIN_HELP}</div>}
    </div>
  );
}

/**
 * K-520: the arrow under a selected card. The frame mounts only while it is open, and the arrow starts closed for
 * every card, because its parent mounts it again for each selection.
 */
export function PeekArrow(props: { resource: Resource; state: State; zone: string }) {
  const [open, setOpen] = useState(false);
  const [large, setLarge] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  return (
    <div class="peek">
      <button
        type="button"
        ref={toggle}
        class="btn peek-toggle"
        aria-expanded={open}
        data-tip={open ? "Close the preview." : "Open a small preview of the address."}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => {
          setOpen(!open);
          setLarge(false);
        }}
      >
        {open ? "▴ Preview" : "▾ Preview"}
      </button>
      {open && !large ? <CardPreview {...props} onEnlarge={() => setLarge(true)} /> : null}
      {open && large ? (
        <LargePreview
          {...props}
          onClose={() => {
            setLarge(false);
            toggle.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

function LargePreview(props: { resource: Resource; state: State; zone: string; onClose: () => void }) {
  const address = props.resource.addresses[0] ?? "";
  const sandbox = frameSandbox(address, location.hostname, props.zone);
  const close = useRef<HTMLButtonElement>(null);
  // Focus inside the dialog makes Escape its own, so the map keeps its selection (App's `ownsEscape`).
  useEffect(() => close.current?.focus(), []);
  if (sandbox === null) return null;
  const url = `https://${address}`;
  return createPortal(
    <div
      class="scrim peek-scrim"
      onClick={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <section
        class="dialog peek-large"
        role="dialog"
        aria-modal="true"
        aria-label={`Preview of ${props.resource.name}`}
        onKeyDown={(event) => event.key === "Escape" && props.onClose()}
      >
        <header class="overlay-head">
          <h2>{props.resource.name}</h2>
          <a
            class="btn"
            href={url}
            target="_blank"
            rel="noreferrer"
            data-tip="Open the address in a new tab."
          >
            Open in new tab
          </a>
          <button
            ref={close}
            type="button"
            class="btn"
            aria-label="Close"
            data-tip="Close the large preview."
            onClick={props.onClose}
          >
            ×
          </button>
        </header>
        <div class="frame">
          <LiveFrame key={url} url={url} label={`Preview of ${address}`} sandbox={sandbox} interact />
        </div>
        {opensForAnyone(props.state, props.resource) ? null : <div class="help">{LOGIN_HELP}</div>}
      </section>
    </div>,
    document.body,
  );
}
