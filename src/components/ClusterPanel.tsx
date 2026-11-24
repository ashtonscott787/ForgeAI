import { useEffect, useState } from "react";
import { api, type ClusterStatus } from "../lib/ipc";

/**
 * Putting several computers behind one model.
 *
 * Two halves, and a machine can be either or both. It can lend itself to
 * another computer, and it can borrow others. The picture at the top shows
 * which it is doing right now, because "is this actually working" is the
 * only question anybody has about a cluster.
 *
 * The warning about the worker is not decoration. The protocol underneath
 * has no authentication at all: anything that can reach the port can run
 * code on this machine's accelerator. So it binds to loopback unless a
 * network address is chosen on purpose, and the sentence saying why sits
 * next to the switch rather than in a document.
 */
export function ClusterPanel() {
  const [s, setS] = useState<ClusterStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const [adding, setAdding] = useState("");

  const look = (check = false) => {
    void api.clusterStatus(check).then(setS).catch(() => setS(null));
  };
  useEffect(() => { look(false); }, []);

  async function run(fn: () => Promise<{ ok: boolean; why?: string }>, done: string) {
    setBusy(true);
    try {
      const r = await fn();
      setSaid(r.ok ? done : (r.why ?? "That did not work."));
      look(false);
    } finally {
      setBusy(false);
    }
  }

  if (!s) return null;

  if (!s.available) {
    return (
      <div className="panel">
        <div className="panel-h"><span className="t">More than one computer</span></div>
        <div className="panel-b">
          <p className="sheet-bad">
            This copy of Forge AI was built without the worker, so a model cannot be split across
            machines. Re-download the app.
          </p>
        </div>
      </div>
    );
  }

  const mine = s.addresses.filter((a) => a.private);

  return (
    <div className="panel">
      <div className="panel-h"><span className="t">More than one computer</span></div>
      <div className="panel-b">
        <p className="hint">
          A model can be split across machines on the same network: this one holds the conversation,
          the others each run part of the model. More memory between them means a larger model than
          any one of them could hold.
        </p>

        {/* Borrowing. */}
        <h4 className="sub">Computers this one uses</h4>
        {s.peers.length === 0 ? (
          <p className="hint">None yet. Add the address of another computer running Forge AI with its worker switched on.</p>
        ) : (
          <ul className="peers">
            {s.peers.map((p) => (
              <li key={p.label} className={`peer${p.ok === false ? " bad" : p.ok ? " good" : ""}`}>
                <span className="peer-dot" aria-hidden="true" />
                <span className="peer-name num">{p.label}</span>
                <span className="peer-state">
                  {p.ok === null
                    ? "not checked"
                    : p.ok
                      ? `answered in ${p.ms}ms`
                      : p.why}
                </span>
                {s.using.includes(p.label) && <span className="peer-using">in use now</span>}
                <button
                  className="ghostbtn small"
                  disabled={busy}
                  onClick={() => void run(() => api.clusterSet({ peers: s.peers.filter((x) => x.label !== p.label).map((x) => x.label) }), "Removed.")}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="peer-add">
          <input
            value={adding}
            placeholder="studio.local or 192.168.1.20:50052"
            aria-label="Address of another computer"
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && adding.trim()) void add(); }}
          />
          <button className="btn" disabled={busy || !adding.trim()} onClick={() => void add()}>Add</button>
          <button className="ghostbtn" disabled={busy || !s.peers.length} onClick={() => { setBusy(true); void api.clusterCheck().then(setS).finally(() => setBusy(false)); }}>
            {busy ? "Checking…" : "Check them"}
          </button>
        </div>

        <label className="row check">
          <input
            type="checkbox"
            checked={s.enabled}
            disabled={busy}
            onChange={(e) => void run(() => api.clusterSet({ enabled: e.target.checked }), e.target.checked ? "On. It takes effect the next time a model starts." : "Off. Models run on this computer alone.")}
          />
          <span>
            Split models across these computers
            <small className="hint">
              Checked when a model starts. A machine that does not answer is left out and the engine log says so, rather than the model refusing to load.
            </small>
          </span>
        </label>

        {s.engine_running && s.enabled && (
          <p className="hint">
            {s.using.length
              ? `Running now across this computer and ${s.using.join(", ")}.`
              : "A model is loaded, and it is running on this computer alone."}
          </p>
        )}

        {/* Lending. */}
        <h4 className="sub">Lend this computer to another</h4>
        <p className="hint">
          Switch this on and another copy of Forge AI can use this machine's memory and processor as
          part of its model. It cannot read your chats, your files or your models: it is handed
          arithmetic and hands back the result.
        </p>
        <p className="sheet-warn">
          There is no password on this. Anything that can reach the port can use this machine, so it
          is offered to this computer only until you choose a network address below.
        </p>

        <div className="worker-row">
          <label>
            <span>Listen on</span>
            <select
              value={s.worker.host}
              disabled={busy || s.worker.running}
              onChange={(e) => void run(() => api.workerSet({ enabled: s.worker.running, host: e.target.value, port: s.worker.port }), "Changed.")}
            >
              <option value="127.0.0.1">this computer only (127.0.0.1)</option>
              {mine.map((a) => (
                <option key={a.address} value={a.address}>{a.address} — {a.name}</option>
              ))}
            </select>
          </label>
          <span className="num worker-port">port {s.worker.port}</span>
          <button
            className={s.worker.running ? "ghostbtn" : "btn primary"}
            disabled={busy}
            onClick={() =>
              void run(
                () => api.workerSet({ enabled: !s.worker.running, host: s.worker.host, port: s.worker.port }),
                s.worker.running ? "Stopped." : `Listening on ${s.worker.host}:${s.worker.port}. Add that address on the other computer.`,
              )
            }
          >
            {s.worker.running ? "Stop lending" : "Start lending"}
          </button>
        </div>

        {s.worker.running && s.worker.log.length > 0 && (
          <pre className="worker-log">{s.worker.log.join("\n")}</pre>
        )}

        {said && <p className="connect-said" role="status">{said}</p>}
      </div>
    </div>
  );

  async function add() {
    const next = [...s!.peers.map((p) => p.label), adding.trim()];
    await run(() => api.clusterSet({ peers: next }), "Added. Press “Check them” to see whether it answers.");
    setAdding("");
  }
}
