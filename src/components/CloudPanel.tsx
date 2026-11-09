import { useState } from "react";
import { PROVIDER_LABEL, PROVIDER_ORDER, connectionLabel, usableModels } from "../lib/cloud";
import { api, type ProviderId, type ProviderStatus } from "../lib/ipc";
import type { LocalModel } from "../lib/models";
import { Mark } from "./Marks";

/**
 * Cloud accounts. A saved key, a verified connection and a failed test are shown
 * as three different states. Keys are typed into a password field, sent once to
 * the keychain, and cleared from this component immediately.
 */
export function CloudPanel({
  providers,
  onProviders,
  models,
  onUseModel,
}: {
  providers: ProviderStatus[];
  onProviders: (p: ProviderStatus[]) => void;
  models: LocalModel[];
  onUseModel: (value: string) => void;
}) {
  return (
    <div className="panel">
      <div className="panel-h"><span className="t">Cloud models</span></div>
      <div className="panel-b">
        <p className="hint">
          Connect your own Anthropic or OpenAI account. Requests go from this computer straight to the provider over HTTPS.
          Your key is stored in the computer's keychain. Chats sent to a cloud model leave this computer; local models do not.
        </p>
        {PROVIDER_ORDER.map((p) => {
          const s = providers.find((x) => x.provider === p);
          return s ? <ProviderCard key={p} status={s} onProviders={onProviders} /> : null;
        })}
        {models.length > 0 && (
          <label className="field">
            <span className="fl">Default model for new chats</span>
            <select defaultValue="" onChange={(e) => e.target.value && onUseModel(e.target.value)}>
              <option value="" disabled>Choose…</option>
              {models.map((m) => (
                <option key={m.value} value={m.value}>{m.name} — {m.family}</option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}

function ProviderCard({ status, onProviders }: { status: ProviderStatus; onProviders: (p: ProviderStatus[]) => void }) {
  const p = status.provider as ProviderId;
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const label = connectionLabel(status);
  const usable = usableModels(status);

  async function run(what: string, fn: () => Promise<ProviderStatus[]>, done?: string) {
    setBusy(what);
    setErr(null);
    setNote(null);
    try {
      const next = await fn();
      onProviders(next);
      if (done) setNote(done);
    } catch (e) {
      // Refresh the stored state so the failure is reflected, then show the reason.
      const fresh = await api.providerStatus().catch(() => null);
      if (fresh) onProviders(fresh);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function connect() {
    const k = key;
    setKey("");
    await run("connect", async () => {
      await api.providerKeySave(p, k);
      return api.providerTest(p);
    }, "Connected. The key was checked against the provider.");
  }

  return (
    <div className="cloudcard" aria-label={`${PROVIDER_LABEL[p]} connection`}>
      <div className="cloudhead">
        <Mark kind={p} size={28} />
        <div>
          <strong>{PROVIDER_LABEL[p]}</strong>
          <div className={`conn conn-${label.tone}`} role="status">{label.text}</div>
        </div>
      </div>

      {err && <div className="banner err"><div className="errtext">{err}</div></div>}
      {!err && status.last_error && !status.verified_at && (
        <div className="hint">Last test: {status.last_error}</div>
      )}
      {note && <div className="hint">{note}</div>}

      {!status.saved ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) void connect();
          }}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={`Paste your ${PROVIDER_LABEL[p]} API key`}
            aria-label={`${PROVIDER_LABEL[p]} API key`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <div className="actions">
            <button type="submit" className="primary" disabled={!key.trim() || busy !== null}>
              {busy === "connect" ? "Checking…" : "Connect"}
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button className="ghostbtn" disabled={busy !== null} onClick={() => void run("test", () => api.providerTest(p), "Connection verified.")}>
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
          {status.verified_at && (
            <button className="ghostbtn" disabled={busy !== null} onClick={() => void run("disconnect", () => api.providerDisconnect(p), "Disconnected. The key is still saved.")}>
              Disconnect
            </button>
          )}
          <button
            className="ghostbtn danger"
            disabled={busy !== null}
            onClick={() => {
              if (window.confirm(`Remove the saved ${PROVIDER_LABEL[p]} key from this computer?`)) {
                void run("remove", () => api.providerRemove(p), "Key removed.");
              }
            }}
          >
            Remove key
          </button>
        </div>
      )}

      {status.saved && (
        <div className="cloudmodels">
          <div className="fl">Models ({usable.length})</div>
          {usable.length === 0 && (
            <div className="hint">No models listed yet. Test the connection, or add a model name below.</div>
          )}
          <ul>
            {usable.map((m) => (
              <li key={m.id}>
                <code>{m.id}</code>
                {m.manual && <span className="hint"> · added by hand</span>}
                {m.manual && (
                  <button className="linkbtn" onClick={() => void run("manual", () => api.providerManualRemove(p, m.id))}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
          <form
            className="actions"
            onSubmit={(e) => {
              e.preventDefault();
              const id = manual.trim();
              if (!id) return;
              setManual("");
              void run("manual", () => api.providerManualAdd(p, id), `Added ${id}.`);
            }}
          >
            <input
              placeholder="Model ID, e.g. exact name from the provider's docs"
              aria-label={`Add a ${PROVIDER_LABEL[p]} model by name`}
              value={manual}
              onChange={(e) => setManual(e.target.value)}
            />
            <button type="submit" className="ghostbtn" disabled={!manual.trim() || busy !== null}>Add model</button>
          </form>
          <p className="hint">
            Context length, vision and tool support are not shown: the provider's model list does not report them here.
            Prices are not shown either.
          </p>
        </div>
      )}
    </div>
  );
}
