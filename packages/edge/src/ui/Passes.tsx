import { useEffect, useState } from "preact/hooks";
import { Check, Switch } from "./controls.tsx";
import { callApi } from "./store.ts";

interface PassSettings {
  readonly on: boolean;
  readonly issuer: string;
  readonly audiences: ReadonlyArray<{
    readonly address: string;
    readonly labels: boolean;
    readonly addedBy: string | null;
  }>;
  readonly keys: ReadonlyArray<{
    readonly kid: string;
    readonly createdAt: number;
    readonly retiredAt: number | null;
  }>;
}

/**
 * K-1770 to K-1774: passes for outside services in Settings: on or off (off until the host move is done), the
 * audiences with "labels in passes", and "Rotate pass key". It reads the settings when it opens.
 */
export function PassSettingsPanel(props: { readonly onToast: (text: string, error: boolean) => void }) {
  const [settings, setSettings] = useState<PassSettings | null>(null);
  const [address, setAddress] = useState("");
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- reads the settings once when the panel opens
  useEffect(() => {
    void callApi<PassSettings>("GET", "/api/passes").then(
      (result) => "error" in result || setSettings(result),
    );
  }, []);
  const call = async (method: "POST" | "DELETE", path: string, body?: object, done?: string) => {
    const result = await callApi<PassSettings>(method, path, body);
    if ("error" in result) return props.onToast(result.error, true);
    setSettings(result);
    if (done) props.onToast(done, false);
  };
  if (!settings) return null;
  return (
    <fieldset class="right-mode">
      <legend data-tip="Passes: 5-minute tokens that outside services check against kitshn's public keys (K-1770).">
        Passes for outside services
      </legend>
      <Switch
        checked={settings.on}
        label="Passes"
        tip={`Passes: ${settings.issuer} issues passes and serves its keys. Turn it on after the host move (K-1209).`}
        onChange={(on) => void call("POST", "/api/passes", { on })}
      />
      <ul class="repo-list">
        {settings.audiences.map((audience) => (
          <li key={audience.address}>
            <code>{audience.address}</code>
            <Check
              checked={audience.labels}
              label="labels in passes"
              tip="Labels in passes: passes for this service carry the verified labels and the thread (K-1772)."
              onChange={(labels) =>
                void call("POST", "/api/passes/audiences", { address: audience.address, labels })
              }
            />
            <button
              type="button"
              class="btn danger"
              data-tip="Remove: passes for this service stop at once."
              onClick={() =>
                void call("DELETE", `/api/passes/audiences/${encodeURIComponent(audience.address)}`)
              }
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <input
        class="field"
        aria-label="New pass audience"
        placeholder="https://service.example.com"
        value={address}
        onInput={(event) => setAddress(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          void call("POST", "/api/passes/audiences", { address, labels: false }, `Added ${address}.`);
          setAddress("");
        }}
      />
      <button
        type="button"
        class="btn"
        data-tip="Rotate pass key: a new key signs from now on; the old one stays in the public keys for 6 minutes (K-1771)."
        onClick={() => void call("POST", "/api/passes/rotate", {}, "Rotated the pass key.")}
      >
        Rotate pass key
      </button>
    </fieldset>
  );
}
