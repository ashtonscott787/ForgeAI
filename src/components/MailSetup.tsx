import { useState } from "react";
import { api } from "../lib/ipc";

/**
 * Setting up a mail account, in as few decisions as it can be done in.
 *
 * What it is for, the address, and the password. Who hosts the address is
 * worked out rather than asked: a personal address usually says outright, and
 * a school or work one is settled by looking at where its domain delivers its
 * mail. Only when neither settles it is anybody asked to pick from a list.
 */
const KINDS = [
  { id: "personal", label: "Personal", note: "Your own address." },
  { id: "school", label: "School", note: "A university or college address." },
  { id: "work", label: "Work", note: "Your employer's address." },
  { id: "other", label: "Other", note: "Anything else." },
] as const;

const CHOICES = [
  { id: "gmail", label: "Google" },
  { id: "icloud", label: "Apple" },
  { id: "microsoft", label: "Microsoft" },
  { id: "other", label: "Something else" },
] as const;

export interface MailDraft {
  kind: string;
  address: string;
  provider: string;
  password: string;
}

export function MailSetup({
  providers,
  onCancel,
  onDone,
}: {
  providers: Record<string, { label: string; note?: string; works?: boolean }>;
  onCancel: () => void;
  onDone: (d: MailDraft) => Promise<string | null>;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [kind, setKind] = useState("");
  const [address, setAddress] = useState("");
  const [provider, setProvider] = useState("");
  const [how, setHow] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const chosen = provider ? providers[provider] : undefined;

  async function look() {
    setProblem(null);
    setBusy(true);
    try {
      const r = await api.mailDetect(address.trim());
      if (!r.ok) { setProblem(r.why || "That address could not be read."); return; }
      setProvider(r.provider || "");
      setHow(r.how || "");
      setStep(3);
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setProblem(null);
    setBusy(true);
    try {
      setProblem(await onDone({ kind, address: address.trim(), provider, password }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-back" role="dialog" aria-modal="true" aria-label="Set up a mail account">
      <div className="sheet">
        <header className="sheet-h">
          <b>Set up a mail account</b>
          <button className="icbtn" aria-label="Close" onClick={onCancel}>×</button>
        </header>

        <div className="sheet-b">
          {step === 1 && (
            <>
              <p className="hint">What is this address for? It only decides how chats are kept apart.</p>
              <div className="pickgrid">
                {KINDS.map((k) => (
                  <button
                    key={k.id}
                    className={`pick${kind === k.id ? " on" : ""}`}
                    onClick={() => { setKind(k.id); setStep(2); }}
                  >
                    <b>{k.label}</b>
                    <span>{k.note}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <label className="flabel" htmlFor="ms-addr">Your email address</label>
              <input
                id="ms-addr"
                className="convsearch"
                type="email"
                autoFocus
                placeholder="you@example.com"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && address.trim()) void look(); }}
              />
              <p className="hint">
                Forge AI looks up who handles this domain's mail so you do not have to know. Only the part
                after the @ is looked up, and only in DNS.
              </p>
              {problem && <p className="sheet-bad">{problem}</p>}
              <div className="sheet-acts">
                <button className="ghostbtn" onClick={() => setStep(1)}>Back</button>
                <button className="btn primary" disabled={!address.trim() || busy} onClick={() => void look()}>
                  {busy ? "Looking…" : "Continue"}
                </button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              {provider ? (
                <p className="sheet-found">
                  This is <b>{chosen?.label || provider}</b>, worked out from {how}.
                </p>
              ) : (
                <>
                  <p className="hint">That domain did not say who handles its mail. Who is it with?</p>
                  <div className="pickgrid tight">
                    {CHOICES.map((c) => (
                      <button
                        key={c.id}
                        className={`pick${provider === c.id ? " on" : ""}`}
                        onClick={() => setProvider(c.id)}
                      >
                        <b>{c.label}</b>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {chosen && chosen.works === false ? (
                <p className="sheet-bad">{chosen.note}</p>
              ) : chosen ? (
                <>
                  {chosen.note && <p className="hint">{chosen.note}</p>}
                  <label className="flabel" htmlFor="ms-pass">Password</label>
                  <input
                    id="ms-pass"
                    className="convsearch"
                    type="password"
                    autoFocus
                    autoComplete="off"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <p className="hint">Kept in this computer's keychain. It is never sent anywhere but your own provider.</p>
                </>
              ) : null}

              {problem && <p className="sheet-bad">{problem}</p>}
              <div className="sheet-acts">
                <button className="ghostbtn" onClick={() => setStep(2)}>Back</button>
                <button
                  className="btn primary"
                  disabled={!provider || !password || busy || chosen?.works === false}
                  onClick={() => void finish()}
                >
                  {busy ? "Checking…" : "Finish"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
