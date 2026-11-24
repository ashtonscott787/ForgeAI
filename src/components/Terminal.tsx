import { useEffect, useRef, useState } from "react";
import { api, type ShellStatus } from "../lib/ipc";

/**
 * A shell, and the assistant's access to it.
 *
 * Commands the assistant writes arrive here as proposals, not as actions.
 * They sit in the box with Run beside them and nothing happens until the
 * person presses it. There is no setting that changes that, and the panel
 * says so where it cannot be missed.
 *
 * It is a pipe, not a terminal emulator: anything that takes over the screen
 * or asks for a password will hang instead of working. Saying that plainly
 * is better than letting somebody discover it by waiting two minutes for vim.
 */
export function Terminal({
  proposed,
  onUsedProposal,
  onClose,
}: {
  /** A command the assistant wrote. Placed in the box; never run. */
  proposed?: string | null;
  onUsedProposal?: () => void;
  onClose?: () => void;
}) {
  const [s, setS] = useState<ShellStatus | null>(null);
  const [text, setText] = useState("");
  const [lines, setLines] = useState<{ kind: "in" | "out" | "bad"; text: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const out = useRef<HTMLDivElement>(null);

  useEffect(() => { void api.shellStatus().then(setS).catch(() => undefined); }, []);

  // Output arrives as it is produced, so a slow command is watchable.
  useEffect(() => {
    const off = api.onShellData(({ chunk }) =>
      setLines((l) => {
        const last = l[l.length - 1];
        if (last?.kind === "out") return [...l.slice(0, -1), { kind: "out", text: last.text + chunk }];
        return [...l, { kind: "out" as const, text: chunk }];
      }),
    );
    return () => void off.then((f) => f()).catch(() => undefined);
  }, []);

  useEffect(() => { if (out.current) out.current.scrollTop = out.current.scrollHeight; }, [lines]);

  // A proposal fills the box and says so. It is never run on arrival.
  useEffect(() => {
    if (!proposed) return;
    setText(proposed);
    void api.shellCheck(proposed).then((c) => setRefusal(c.allowed ? null : c.why));
    onUsedProposal?.();
  }, [proposed]);

  async function run() {
    const command = text.trim();
    if (!command || busy) return;
    setBusy(true);
    setRefusal(null);
    setLines((l) => [...l, { kind: "in", text: command }]);
    try {
      const r = await api.shellRun(command);
      if (!r.ok) setLines((l) => [...l, { kind: "bad", text: r.why ?? "That did not work." }]);
      else if (r.code !== 0) setLines((l) => [...l, { kind: "bad", text: `exit ${r.code}` }]);
      setText("");
    } finally {
      setBusy(false);
    }
  }

  if (!s) return null;

  return (
    <div className="term">
      <div className="term-h">
        <strong>Shell</strong>
        {s.open ? <span className="hint num term-cwd" title={s.cwd}>{s.cwd}</span> : null}
        <span className="term-acts">
          {s.open ? (
            <>
              <button className="ghostbtn small" onClick={() => void api.shellInterrupt()}>Interrupt</button>
              <button className="ghostbtn small" onClick={() => void api.shellClose().then(setS)}>Close</button>
            </>
          ) : null}
          {onClose && <button className="ghostbtn small" onClick={onClose} aria-label="Hide the shell">Hide</button>}
        </span>
      </div>

      {!s.open ? (
        <div className="term-start">
          <p className="hint">
            A shell on this computer, running where you choose. The assistant can write a command into
            the box; it cannot run one. Every command is run by you pressing Run.
          </p>
          <p className="hint">
            It is a pipe rather than a real terminal, so anything that takes over the screen or asks
            for a password — vim, top, ssh — will hang instead of working.
          </p>
          <div className="sheet-acts left">
            <button className="btn primary" onClick={() => void api.shellOpen().then((r) => r.ok && setS(r))}>
              Open it in my home folder
            </button>
            <button
              className="ghostbtn"
              onClick={() =>
                void api.shellPickFolder().then((p) => {
                  if (p.ok && p.cwd) void api.shellOpen(p.cwd).then((r) => r.ok && setS(r));
                })
              }
            >
              Choose a folder…
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="term-out" ref={out} role="log" aria-label="Shell output">
            {lines.length === 0 && <div className="hint">Nothing has run yet.</div>}
            {lines.map((l, i) => (
              <div key={i} className={`term-line ${l.kind}`}>
                {l.kind === "in" ? <span className="term-prompt" aria-hidden="true">$ </span> : null}
                {l.text}
              </div>
            ))}
          </div>

          {refusal && <p className="sheet-bad term-refusal">{refusal}</p>}

          <div className="term-in">
            <textarea
              rows={Math.min(5, text.split("\n").length)}
              value={text}
              placeholder="A command. Nothing runs until you press Run."
              aria-label="Command to run"
              disabled={busy}
              onChange={(e) => {
                setText(e.target.value);
                if (refusal) setRefusal(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void run();
                }
              }}
            />
            <button className="btn primary" disabled={busy || !text.trim() || Boolean(refusal)} onClick={() => void run()}>
              {busy ? "Running…" : "Run"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
