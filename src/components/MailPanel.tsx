import { useEffect, useState } from "react";
import { api } from "../lib/ipc";

/**
 * The person's own outgoing mail account.
 *
 * Forge AI drafts; a person sends. Nothing is sent from here, and the password
 * goes to the operating system's key store rather than into settings. Until an
 * account is set up, a drafted email says plainly that it cannot be sent and
 * offers to be copied instead.
 */
export function MailPanel() {
  const [s, setS] = useState({ host: "", port: 587, secure: false, user: "", from: "", has_password: false, configured: false });
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => void api.mailStatus().then(setS).catch(() => undefined);
  useEffect(load, []);

  const save = () => {
    setBusy(true);
    setNote("");
    void api
      .mailSave({ host: s.host.trim(), port: Number(s.port) || 587, secure: s.secure, user: s.user.trim(), from: s.from.trim(), password: password || undefined })
      .then(() => { setPassword(""); setNote("Saved."); load(); })
      .catch((e) => setNote(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="panel" aria-label="Outgoing email account">
      <div className="panel-h"><span className="t">Email</span></div>
      <div className="panel-b">
        <p className="hint">
          Your own outgoing mail account, so a drafted email can be sent from
          Forge AI. Every message is shown in full and sent only when you press
          the button — never by a model, and never on its own.
        </p>

        <label className="fl" htmlFor="m-from">Send as</label>
        <input id="m-from" className="setinput" placeholder="Your Name &lt;you@example.com&gt;"
          value={s.from} onChange={(e) => setS({ ...s, from: e.target.value })} />

        <label className="fl" htmlFor="m-host">Outgoing server (SMTP)</label>
        <input id="m-host" className="setinput" placeholder="smtp.example.com"
          value={s.host} onChange={(e) => setS({ ...s, host: e.target.value })} />

        <div className="sharerow">
          <label className="fl" htmlFor="m-port">Port</label>
          <input id="m-port" className="setinput" style={{ maxWidth: 110 }} type="number"
            value={s.port} onChange={(e) => setS({ ...s, port: Number(e.target.value) })} />
          <label className="fieldrow" style={{ margin: 0 }}>
            <span className="fl">Connect over TLS directly</span>
            <input type="checkbox" role="switch" aria-label="Connect over TLS directly"
              checked={s.secure} onChange={(e) => setS({ ...s, secure: e.target.checked })} />
          </label>
        </div>
        <p className="hint">
          Port 587 with STARTTLS suits most providers; 465 usually wants TLS
          directly. Forge AI refuses to send a password unencrypted to anything
          that is not on this computer.
        </p>

        <label className="fl" htmlFor="m-user">Username</label>
        <input id="m-user" className="setinput" placeholder="you@example.com"
          value={s.user} onChange={(e) => setS({ ...s, user: e.target.value })} />

        <label className="fl" htmlFor="m-pass">Password</label>
        <input id="m-pass" className="setinput" type="password"
          placeholder={s.has_password ? "A password is saved" : "App password, not your main one, where your provider offers that"}
          value={password} onChange={(e) => setPassword(e.target.value)} />

        <div className="sharerow">
          <button type="button" className="ghostbtn" disabled={busy || !s.host.trim() || !s.from.trim()} onClick={save}>
            {busy ? "Saving…" : "Save account"}
          </button>
          {s.configured && <span className="hint">Set up. Drafted emails can be sent.</span>}
        </div>
        {note && <div className="hint">{note}</div>}
        <p className="hint">
          Reading your inbox is not built. Forge AI can write and send, not receive.
        </p>
      </div>
    </div>
  );
}
