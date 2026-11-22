import { useEffect, useState } from "react";
import { MailSetup } from "../components/MailSetup";
import { api, type MailHeader } from "../lib/ipc";

/**
 * Your inbox, and a way to hand any of it to the chat.
 *
 * Reading is read-only all the way down: nothing here deletes, moves or marks
 * anything, because a tool that can quietly change a mailbox is a different
 * risk from one that can read it. Replies are drafted in the chat and sent
 * only when a person presses the button there.
 */
export function Mail({ onAsk }: { onAsk: (text: string) => void }) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [rows, setRows] = useState<MailHeader[]>([]);
  const [open, setOpen] = useState<{ uid: number; subject: string; from: string; date: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [setup, setSetup] = useState(false);
  const [providers, setProviders] = useState<Record<string, { label: string; note?: string; works?: boolean }>>({});

  useEffect(() => { void api.mailProviders().then(setProviders).catch(() => undefined); }, []);

  /**
   * Saves what the wizard gathered. The servers come from the preset for the
   * provider that was worked out, so nobody types a host name.
   */
  async function saveSetup(d: { kind: string; address: string; provider: string; password: string }) {
    const preset = (await api.mailProviders())[d.provider];
    if (!preset || !preset.smtp || !preset.imap) return "That provider has no server settings.";
    const r = await api.mailSave({
      host: preset.smtp.host,
      port: preset.smtp.port,
      secure: preset.smtp.secure,
      imap_host: preset.imap.host,
      imap_port: preset.imap.port,
      user: d.address,
      from: d.address,
      password: d.password,
      provider: d.provider,
    });
    if (!r.ok) return "Those details were refused. Check the password and try again.";
    const st = await api.mailStatus();
    setReady(st.can_read);
    setSetup(false);
    if (st.can_read) void load();
    return null;
  }

  useEffect(() => {
    void api.mailStatus().then((s) => {
      setReady(s.can_read);
      if (s.can_read) void load();
    }).catch(() => setReady(false));
  }, []);

  async function load() {
    setBusy(true);
    setError("");
    try {
      const r = await api.mailInbox({ count: 30 });
      if (r.ok) setRows(r.messages ?? []);
      else setError(r.error ?? "The inbox could not be read.");
    } finally {
      setBusy(false);
    }
  }

  async function read(uid: number) {
    setBusy(true);
    setError("");
    try {
      const m = await api.mailRead({ uid });
      if (m.ok) setOpen({ uid, subject: m.subject ?? "", from: m.from ?? "", date: m.date ?? "", text: m.text ?? "" });
      else setError(m.error ?? "That message could not be read.");
    } finally {
      setBusy(false);
    }
  }

  if (ready === false) {
    return (
      <>
        <div className="phead"><h2>Mail</h2><p>Your inbox, read on this computer.</p></div>
        <div className="scroll"><div className="pbody">
          <div className="panel"><div className="panel-b">
            <p>No mail account is set up yet.</p>
            <p className="hint">
              Three answers and it is done: what the address is for, the address, and a password.
              Forge AI works out who hosts it. Nothing is read until you have finished.
            </p>
            <div className="sheet-acts left">
              <button className="btn primary" onClick={() => setSetup(true)}>Set up a mail account</button>
            </div>
          </div></div>
        </div></div>
        {setup && (
          <MailSetup providers={providers} onCancel={() => setSetup(false)} onDone={saveSetup} />
        )}
      </>
    );
  }

  return (
    <>
      <div className="phead">
        <h2>Mail</h2>
        <p>Read on this computer. Nothing here deletes, moves or marks anything as read.</p>
      </div>
      <div className="scroll">
        <div className="pbody">
          <div className="sharerow">
            <button className="ghostbtn" disabled={busy} onClick={() => void load()}>{busy ? "Reading…" : "Refresh"}</button>
            {rows.length > 0 && (
              <button
                className="ghostbtn"
                onClick={() => onAsk(
                  `Here are the ${rows.length} most recent emails. Summarise what needs me, and say which can wait. Do not invent anything that is not listed.\n\n` +
                  rows.map((m) => `${m.unread ? "UNREAD " : ""}${m.from} — ${m.subject} (${m.date})`).join("\n"),
                )}
              >
                Summarise these in chat
              </button>
            )}
            {rows.length > 0 && <span className="hint">{rows.filter((m) => m.unread).length} unread of {rows.length}</span>}
          </div>

          {error && <div className="banner warn" role="status">{error}</div>}

          {!error && !rows.length && !busy && <p className="hint">Nothing in the inbox.</p>}

          <ul className="maillist">
            {rows.map((m) => (
              <li key={m.uid} className={`mailrow${m.unread ? " unread" : ""}${open?.uid === m.uid ? " on" : ""}`}>
                <button className="mailmain" onClick={() => void read(m.uid)}>
                  <span className="mailfrom">{m.from.replace(/\s*<[^>]+>/, "") || m.from}</span>
                  <span className="mailsubj">{m.subject}</span>
                  <span className="maildate num">{m.date.replace(/\s*\+\d{4}$/, "")}</span>
                </button>
              </li>
            ))}
          </ul>

          {open && (
            <div className="packedit mailopen">
              <div className="panel-h">
                <span className="t">{open.subject}</span>
                <button className="ghostbtn" onClick={() => setOpen(null)}>Close</button>
              </div>
              <p className="hint num">{open.from} · {open.date}</p>
              <div className="sharerow">
                <button className="ghostbtn" onClick={() => onAsk(`Draft a reply to this email. Keep it short and do not promise anything it does not already say.\n\nFrom: ${open.from}\nSubject: ${open.subject}\n\n${open.text}`)}>
                  Draft a reply
                </button>
                <button className="ghostbtn" onClick={() => onAsk(`Summarise this email and list anything it asks me to do.\n\nFrom: ${open.from}\nSubject: ${open.subject}\n\n${open.text}`)}>
                  Summarise it
                </button>
              </div>
              <pre className="mailbody">{open.text || "(no readable text in this message)"}</pre>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
