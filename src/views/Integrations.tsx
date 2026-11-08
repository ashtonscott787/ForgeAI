import { useEffect, useState } from "react";
import { api, type SecretStatus } from "../lib/ipc";

interface Provider {
  id: string;
  name: string;
  what: string;
  keyUrl: string;
  cost: string;
  ready: boolean;
}

/**
 * Connections to outside services.
 *
 * A card only reads Connected after a real authenticated call to that provider
 * has succeeded — saving a key is not the same as the key working. Services
 * that are not implemented yet say so rather than showing a button that does
 * nothing.
 */
const PROVIDERS: Provider[] = [
  {
    id: "perplexity",
    name: "Perplexity",
    what: "Live web research with citations. Forge AI asks it a question and shows the sources it used.",
    keyUrl: "https://www.perplexity.ai/account/api/group",
    cost: "Paid per request, billed by Perplexity. Their API is separate from a Pro subscription.",
    ready: true,
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    what: "Reads a web page and turns it into clean text, and can search the web when Perplexity is not connected.",
    keyUrl: "https://www.firecrawl.dev/app/api-keys",
    cost: "Free allowance, then paid per page.",
    ready: true,
  },
];

const PLANNED = [
  ["Gmail and Google Calendar", "Reading mail, drafting replies and managing events. Next release, over IMAP and CalDAV with an app password, so no Google Cloud project is needed."],
  ["iCloud Mail and Calendar", "Same approach: an app-specific password from your Apple account."],
  ["Outlook and Microsoft 365", "After Gmail, through the same mail layer."],
  ["Google Drive, Docs and Sheets", "Needs an OAuth application registered under your own Google account."],
  ["Higgsfield", "Image and video generation. Waiting on their current API."],
  ["Zapier", "Workflow automation across other apps."],
];

export function Integrations() {
  const [status, setStatus] = useState<SecretStatus | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () => void api.secretStatus().then(setStatus).catch(() => undefined);
  useEffect(refresh, []);

  async function connect(p: Provider) {
    setBusy(p.id);
    setError(null);
    setNotice(null);
    try {
      const r = await api.secretConnect(p.id, keys[p.id] ?? "");
      setKeys((k) => ({ ...k, [p.id]: "" }));
      setNotice(`${p.name} connected — ${r.detail}.`);
      refresh();
    } catch (e) {
      setError(`${p.name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="scroll pane">
      <div className="pane-head">
        <div>
          <h2>Integrations</h2>
          <p className="sub">
            Forge AI works entirely on this computer by default. These connections are optional, use
            your own account with each service, and are listed as connected only once a real call to
            that service has succeeded.
          </p>
        </div>
      </div>

      {status && !status.available && (
        <div className="banner warn">
          This computer&rsquo;s secure key storage is unavailable, so Forge AI will not save API keys.
          It would have to write them in plain text, which is worse than not saving them.
        </div>
      )}
      {error && <div className="banner err">{error}</div>}
      {notice && <div className="banner">{notice}</div>}

      <h3 className="secthead">Available now</h3>
      <div className="grid">
        {PROVIDERS.map((p) => {
          const s = status?.providers[p.id];
          const connected = s?.verified === true;
          return (
            <div key={p.id} className="mcard">
              <div className="mcard-top">
                <div>
                  <div className="mcard-name">{p.name}</div>
                  <div className="mcard-sub">{connected ? `Connected · key ending ${s?.hint}` : "Not connected"}</div>
                </div>
                <span className={`pill ${connected ? "on" : ""}`}>{connected ? "Connected" : "Needs a key"}</span>
              </div>
              <p className="mcard-meta">{p.what}</p>
              <p className="mcard-meta">{p.cost}</p>

              {connected ? (
                <div className="mcard-actions">
                  <button
                    className="ghostbtn grow"
                    onClick={() => void api.secretClear(p.id).then(refresh)}
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <>
                  <input
                    className="inp"
                    type="password"
                    placeholder="Paste the API key"
                    value={keys[p.id] ?? ""}
                    onChange={(e) => setKeys((k) => ({ ...k, [p.id]: e.target.value }))}
                  />
                  <div className="mcard-actions">
                    <button className="primary" disabled={busy === p.id || !(keys[p.id] ?? "").trim()} onClick={() => void connect(p)}>
                      {busy === p.id ? "Checking…" : "Connect"}
                    </button>
                    <button className="ghostbtn" onClick={() => void api.openExternal(p.keyUrl)}>
                      Get a key
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      <h3 className="secthead">Not built yet</h3>
      <div className="grid">
        {PLANNED.map(([name, note]) => (
          <div key={name} className="mcard planned">
            <div className="mcard-name">{name}</div>
            <p className="mcard-meta">{note}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
