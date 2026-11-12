import { useEffect, useState } from "react";
import { api, type ShareStatus } from "../lib/ipc";

/**
 * Lets other applications on this computer — and, on a private mesh, another
 * computer — send requests to the models already downloaded here, instead of
 * to a paid API.
 *
 * The address and token are shown, never sent anywhere. Nothing is reachable
 * until the switch is on, and nothing is reachable without the token.
 */
export function SharePanel() {
  const [s, setS] = useState<ShareStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState("");

  const load = () => void api.shareStatus().then(setS).catch(() => undefined);
  useEffect(load, []);

  const set = (patch: { enabled?: boolean; port?: number; mesh?: boolean }) => {
    if (!s) return;
    setBusy(true);
    void api
      .shareSet({ enabled: patch.enabled ?? s.enabled, port: patch.port ?? s.port, mesh: patch.mesh ?? s.mesh_enabled })
      .then(setS)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  const copy = (what: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(""), 1200);
    }).catch(() => undefined);
  };

  if (!s) return null;
  const base = s.urls[0] ?? `http://127.0.0.1:${s.port}`;

  return (
    <div className="panel" aria-label="Share this machine">
      <div className="panel-h"><span className="t">Share this machine</span></div>
      <div className="panel-b">
        <p className="hint">
          Other apps can send chat requests to the models on this computer, using the
          OpenAI format. Point Claude, ChatGPT, an editor or a script at the address
          below and your own model answers, so no subscription is spent.
        </p>

        <label className="fieldrow">
          <span className="fl">Allow other apps to use this machine</span>
          <input
            type="checkbox"
            role="switch"
            aria-label="Allow other apps to use this machine"
            checked={s.enabled}
            disabled={busy}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
        </label>

        {s.enabled && (
          <>
            <label className="fieldrow">
              <span className="fl">Also allow another computer on my private mesh</span>
              <input
                type="checkbox"
                role="switch"
                aria-label="Also allow another computer on my private mesh"
                checked={s.mesh_enabled}
                disabled={busy}
                onChange={(e) => set({ mesh: e.target.checked })}
              />
            </label>
            <p className="hint">
              {s.mesh_address
                ? `This machine is on a private mesh as ${s.mesh_address}. Another computer running Tailscale can reach it at that address — and nowhere else can.`
                : "No private mesh address was found. Start Tailscale on both computers, then switch this on."}
            </p>

            {s.error && <div className="banner warn" role="status">{s.error}</div>}

            <div className="sharerow">
              <span className="fl">Address</span>
              <code className="num">{base}/v1</code>
              <button type="button" className="ghostbtn" onClick={() => copy("address", `${base}/v1`)}>
                {copied === "address" ? "Copied" : "Copy"}
              </button>
            </div>
            {s.urls[1] && (
              <div className="sharerow">
                <span className="fl">From the mesh</span>
                <code className="num">{s.urls[1]}/v1</code>
                <button type="button" className="ghostbtn" onClick={() => copy("mesh", `${s.urls[1]}/v1`)}>
                  {copied === "mesh" ? "Copied" : "Copy"}
                </button>
              </div>
            )}

            <div className="sharerow">
              <span className="fl">Token</span>
              <code className="num">{shown ? s.token : "••••••••••••••••"}</code>
              <button type="button" className="ghostbtn" onClick={() => setShown((v) => !v)}>{shown ? "Hide" : "Show"}</button>
              <button type="button" className="ghostbtn" onClick={() => copy("token", s.token ?? "")}>
                {copied === "token" ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                className="ghostbtn"
                disabled={busy}
                onClick={() => { setBusy(true); void api.shareNewToken().then(setS).finally(() => setBusy(false)); }}
              >
                New token
              </button>
            </div>
            <p className="hint">
              Anything holding this token can use the models here, so treat it like a
              password. A new token stops whatever was using the old one.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
