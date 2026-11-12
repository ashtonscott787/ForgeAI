import { useEffect, useState } from "react";
import type { EmailParts } from "../lib/blocks";
import { api } from "../lib/ipc";
import { CopyButton } from "./Copy";

/**
 * A drafted email, with each part copyable on its own — recipients, subject
 * and body go into different boxes in every mail client, so they get different
 * buttons.
 */
export function EmailCard({ email }: { email: EmailParts }) {
  // Sending needs an account and a person. The model drafted this; it cannot
  // send it, and the button below is the only path that can.
  const [canSend, setCanSend] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [note, setNote] = useState("");

  useEffect(() => {
    void api.mailStatus().then((s) => setCanSend(s.configured)).catch(() => undefined);
  }, []);

  async function send() {
    setState("sending");
    setNote("");
    try {
      const r = await api.mailSend({ to: email.to, cc: email.cc || undefined, subject: email.subject, text: email.body, approved: true });
      if (r.ok) { setState("sent"); setNote(`Sent to ${r.recipients} recipient${r.recipients === 1 ? "" : "s"}.`); }
      else { setState("failed"); setNote(r.error ?? "It was not sent."); }
    } catch (e) {
      setState("failed");
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setConfirming(false);
    }
  }

  const full = [`To: ${email.to}`, email.cc ? `Cc: ${email.cc}` : null, `Subject: ${email.subject}`, "", email.body]
    .filter((l) => l !== null)
    .join("\n");

  return (
    <div className="emailcard">
      <div className="erow">
        <span className="elabel">To</span>
        <span className="evalue">{email.to}</span>
        <CopyButton text={email.to} label="Copy" />
      </div>
      {email.cc && (
        <div className="erow">
          <span className="elabel">Cc</span>
          <span className="evalue">{email.cc}</span>
          <CopyButton text={email.cc} label="Copy" />
        </div>
      )}
      <div className="erow">
        <span className="elabel">Subject</span>
        <span className="evalue">{email.subject}</span>
        <CopyButton text={email.subject} label="Copy" />
      </div>
      <div className="ebody">{email.body}</div>
      <div className="eactions">
        <CopyButton text={email.body} label="Copy message" className="primary" />
        <CopyButton text={full} label="Copy all" />
        {canSend && state !== "sent" && !confirming && (
          <button type="button" className="ghostbtn" disabled={state === "sending"} onClick={() => setConfirming(true)}>
            {state === "sending" ? "Sending…" : "Send this"}
          </button>
        )}
        {confirming && (
          <>
            <span className="hint">Send to {email.to}?</span>
            <button type="button" className="ghostbtn" onClick={() => void send()}>Yes, send</button>
            <button type="button" className="ghostbtn" onClick={() => setConfirming(false)}>Cancel</button>
          </>
        )}
      </div>
      {!canSend && (
        <div className="hint emailnote">
          Forge AI cannot send this: no outgoing mail account is set up. Add one in
          Settings, under Email. Copy it into your mail app in the meantime.
        </div>
      )}
      {note && <div className={`emailnote ${state === "failed" ? "warnText" : "hint"}`}>{note}</div>}
    </div>
  );
}
