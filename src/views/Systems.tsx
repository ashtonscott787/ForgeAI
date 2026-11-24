import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Finding, type SecurityReport, type StatusRow, type SystemStatus } from "../lib/ipc";
import { ClusterPanel } from "../components/ClusterPanel";

/**
 * What is connected, drawn rather than listed.
 *
 * Every dot is a real check with a real duration. Nothing is green because it
 * was configured — a mail server that is set up but refusing a password shows
 * as failed, which is the whole reason to draw this at all.
 *
 * Four states, not two: connected, off, not set up, and failed. Collapsing
 * those into a red or green dot would hide the difference between a thing you
 * have not switched on and a thing that is broken.
 */
const COLOUR: Record<StatusRow["state"], string> = {
  connected: "var(--ok, #35b36b)",
  failed: "var(--bad, #d9534f)",
  not_set_up: "var(--fg-3, #8b8b94)",
  off: "var(--line-strong, #3a3a42)",
};
const WORD: Record<StatusRow["state"], string> = {
  connected: "connected",
  failed: "not working",
  not_set_up: "not set up",
  off: "off",
};

export function Systems({ onAsk }: { onAsk: (text: string) => void }) {
  const [snap, setSnap] = useState<SystemStatus | null>(null);
  const [audit, setAudit] = useState<SecurityReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(() => {
    setBusy(true);
    void api.systemStatus().then(setSnap).catch(() => undefined).finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    refresh();
    void api.securityAudit().then(setAudit).catch(() => undefined);
  }, [refresh]);

  // Live means live, but not so often that it becomes the thing using the
  // machine. Every twelve seconds, and only while this page is open.
  useEffect(() => {
    if (!live) return;
    timer.current = setInterval(refresh, 12_000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [live, refresh]);

  const groups = snap ? [...new Set(snap.rows.map((r) => r.group))] : [];

  return (
    <>
      <div className="phead">
        <h2>Systems</h2>
        <p>What is connected right now, checked each time — not remembered from when you set it up.</p>
      </div>
      <div className="scroll">
        <div className="pbody">
          <div className="sysbar">
            <span className={`sysdot ${snap?.worst ?? "off"}`} aria-hidden="true" />
            <strong>{snap?.headline ?? "Checking…"}</strong>
            <span className="hint num">{snap ? new Date(snap.at).toLocaleTimeString() : ""}</span>
            <span className="sysacts">
              <label className="hint livetoggle">
                <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} aria-label="Keep checking" />
                Keep checking
              </label>
              <button className="ghostbtn" disabled={busy} onClick={refresh}>{busy ? "Checking…" : "Check now"}</button>
            </span>
          </div>

          {snap && (
            <div className="sysmap" role="img" aria-label={`Connections: ${snap.headline}`}>
              <div className="sysroot">
                <span className="sysroot-dot" />
                <span className="sysroot-label">Forge AI</span>
              </div>
              <div className="sysbranches">
                {groups.map((g) => (
                  <div key={g} className="sysgroup">
                    <div className="sysgroup-name">{g}</div>
                    {snap.rows.filter((r) => r.group === g).map((r) => (
                      <div key={`${g}-${r.name}`} className={`sysrow ${r.state}`} title={r.note || WORD[r.state]}>
                        <span className="syswire" aria-hidden="true">
                          <i style={{ background: COLOUR[r.state] }} />
                        </span>
                        <span className="sysname">{r.name}</span>
                        <span className="sysdetail">{r.detail}</span>
                        <span className={`sysms ${r.state}`}>
                          {r.ms !== null ? `${r.ms} ms` : WORD[r.state]}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {snap && snap.rows.some((r) => r.note) && (
            <ul className="sysnotes">
              {snap.rows.filter((r) => r.note).map((r) => (
                <li key={`n-${r.group}-${r.name}`}>
                  <strong>{r.name}</strong> — {r.note}
                </li>
              ))}
            </ul>
          )}

          <ClusterPanel />

          <Security report={audit} onAsk={onAsk} onRefresh={() => void api.securityAudit().then(setAudit).catch(() => undefined)} />
        </div>
      </div>
    </>
  );
}

/** Weak points, and a way to take one into the chat and work on it. */
function Security({ report, onAsk, onRefresh }: { report: SecurityReport | null; onAsk: (t: string) => void; onRefresh: () => void }) {
  if (!report) return null;
  const ask = (f: Finding) =>
    onAsk(
      `Forge AI's security check found this. Explain what it means in plain words, how someone could actually take advantage of it, and walk me through fixing it. If it does not matter much for a single-user machine, say so.\n\n` +
      `Severity: ${f.severity}\nArea: ${f.area}\nFinding: ${f.title}\nWhat was seen: ${f.found}\nSuggested fix: ${f.fix}`,
    );

  return (
    <div className="panel syssec" aria-label="Security check">
      <div className="panel-h">
        <span className="t">Security check</span>
        <span className={`sysdot ${report.worst === "ok" ? "connected" : report.worst}`} aria-hidden="true" />
        <span className="hint">{report.headline}</span>
        <button className="ghostbtn" onClick={onRefresh}>Check again</button>
      </div>
      <div className="panel-b">
        <p className="hint">{report.scope}</p>
        {report.findings.length === 0 ? (
          <p className="hint">Nothing found.</p>
        ) : (
          <ul className="findlist">
            {report.findings.map((f) => (
              <li key={f.id} className={`findrow ${f.severity}`}>
                <div className="findhead">
                  <span className={`findsev ${f.severity}`}>{f.severity}</span>
                  <strong>{f.title}</strong>
                  <span className="hint">{f.area}</span>
                  <button className="ghostbtn" onClick={() => ask(f)}>Work on this</button>
                </div>
                <div className="hint">{f.found}</div>
                <div className="findfix">{f.fix}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
