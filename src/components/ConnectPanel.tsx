import { useEffect, useState } from "react";
import { api } from "../lib/ipc";

/**
 * Letting Claude or ChatGPT use the model on this machine.
 *
 * One button. Finding the right configuration file, getting the path to this
 * application right and not wrecking whatever else is in it is the whole of
 * the job, and it is exactly the kind of job nobody should be asked to do by
 * hand with a text editor.
 *
 * What it says before it does anything matters as much as the doing: it names
 * the file it will write to and lists what else is already in there, so
 * nobody presses a button that edits another program's settings blind.
 */
const APPS = [
  { id: "claude", label: "Claude", note: "Claude Desktop. Restart Claude afterwards for it to notice." },
  { id: "chatgpt", label: "ChatGPT", note: "ChatGPT Desktop, with developer mode switched on." },
] as const;

type Plan = Awaited<ReturnType<typeof api.connectPlan>>;

export function ConnectPanel() {
  const [which, setWhich] = useState<string>("claude");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const [copied, setCopied] = useState(false);

  // Re-reading the file does not clear what was just said about it: pressing
  // Connect set the message and the refresh that followed wiped it, so the
  // button appeared to do nothing at all.
  const look = (app: string) => {
    void api.connectPlan(app).then(setPlan).catch(() => setPlan(null));
  };

  useEffect(() => {
    setSaid("");
    look(which);
  }, [which]);

  const app = APPS.find((a) => a.id === which)!;

  async function apply() {
    setBusy(true);
    try {
      const r = await api.connectApply(which);
      setSaid(r.ok ? `${r.note} ${app.note}` : (r.why ?? "That did not work."));
      look(which);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const r = await api.connectRemove(which);
      setSaid(r.ok ? (r.note ?? "Removed.") : (r.why ?? "That did not work."));
      look(which);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-h"><span className="t">Let Claude or ChatGPT use this machine</span></div>
      <div className="panel-b">
        <p className="hint">
          Work handed to Forge AI is answered by the model on this computer. It costs nothing against a
          subscription and never leaves the machine. There is nothing to install: the entry points at this
          application.
        </p>

        <div className="seg wide connect-pick" role="tablist">
          {APPS.map((a) => (
            <button
              key={a.id}
              role="tab"
              aria-selected={which === a.id}
              className={which === a.id ? "on" : ""}
              onClick={() => setWhich(a.id)}
            >
              {a.label}
            </button>
          ))}
        </div>

        {plan && !plan.ok && <p className="sheet-bad">{plan.why}</p>}

        {plan && plan.ok && (
          <>
            <dl className="connect-facts">
              <div><dt>File</dt><dd className="num">{plan.file}</dd></div>
              <div>
                <dt>Already there</dt>
                <dd>{plan.others?.length ? plan.others.join(", ") : "nothing else"}</dd>
              </div>
              <div>
                <dt>Forge AI</dt>
                <dd>{plan.same ? "connected" : plan.already ? "connected, but pointing somewhere else" : "not connected"}</dd>
              </div>
            </dl>

            <div className="sheet-acts left">
              <button className="btn primary" disabled={busy || plan.same} onClick={() => void apply()}>
                {busy ? "Working…" : plan.same ? "Connected" : plan.already ? "Point it here" : `Connect to ${app.label}`}
              </button>
              {plan.already && (
                <button className="ghostbtn" disabled={busy} onClick={() => void remove()}>Disconnect</button>
              )}
            </div>
            <p className="hint">Nothing else in that file is changed. If it cannot be read, it is left alone.</p>
          </>
        )}

        {said && <p className="connect-said" role="status">{said}</p>}

        {plan?.command && (
          <>
            <p className="hint connect-or">Or, for Claude Code, one command:</p>
            <div className="connect-cmd">
              <code>{plan.command}</code>
              <button
                className="ghostbtn small"
                onClick={() => {
                  void navigator.clipboard.writeText(plan.command!).then(
                    () => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); },
                    () => undefined,
                  );
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
