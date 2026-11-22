import { useCallback, useEffect, useState } from "react";
import { api, type AgentActivity } from "../lib/ipc";
import { AgentJourneys } from "./AgentJourneys";
import { AgentStage } from "./AgentStage";

/**
 * What the agents have been doing, drawn.
 *
 * The honest shape of this matters. Agents run one at a time and never contact
 * each other, so there are no arrows between them. What can truthfully be
 * drawn is where two agents share a permission or a knowledge pack — a shared
 * resource, not a conversation — and the legend says exactly that rather than
 * letting the picture imply more than is true.
 */
const KIND: Record<string, string> = {
  started: "started",
  tool: "used a tool",
  approval: "waited for you",
  finished: "finished",
  failed: "failed",
};

export function AgentMap() {
  const [data, setData] = useState<AgentActivity | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setBusy(true);
    void api.agentActivity().then(setData).catch(() => undefined).finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!data) return null;
  const busiest = Math.max(1, ...data.agents.map((a) => a.calls));

  return (
    <div className="amap" aria-label="Agent activity">
      <div className="amap-h">
        <strong>What your agents have done</strong>
        <span className="hint">{data.events} recorded</span>
        <span className="amap-acts">
          <button className="ghostbtn" disabled={busy} onClick={refresh}>{busy ? "Reading…" : "Refresh"}</button>
          {data.events > 0 && (
            <button className="ghostbtn" onClick={() => void api.agentActivityClear().then(refresh)}>Clear history</button>
          )}
        </span>
      </div>

      {data.agents.length === 0 ? (
        <p className="hint amap-pad">No agents yet.</p>
      ) : (
        <>
          {/* Where they went, before how often they ran: the journey is the
              part worth looking at. */}
          <AgentStage data={data} />

          <AgentJourneys agents={data.agents} />

          <div className="amap-grid">
            {data.agents.map((a) => (
              <div key={a.id} className={`anode${a.failures ? " hasfail" : ""}${a.calls ? " active" : ""}`}>
                <div className="anode-h">
                  <span className="anode-icon" aria-hidden="true">{a.icon}</span>
                  <span className="anode-name">{a.name}</span>
                  {a.last_kind && <span className={`anode-state ${a.last_kind}`}>{KIND[a.last_kind] ?? a.last_kind}</span>}
                </div>
                <div className="anode-bar" aria-hidden="true">
                  <i style={{ width: `${Math.round((a.calls / busiest) * 100)}%` }} />
                </div>
                <div className="anode-nums num">
                  {a.runs} run{a.runs === 1 ? "" : "s"} · {a.calls} action{a.calls === 1 ? "" : "s"}
                  {a.waiting > 0 && <span className="anode-wait"> · {a.waiting} waited for you</span>}
                  {a.failures > 0 && <span className="anode-fail"> · {a.failures} failed</span>}
                </div>
                {Object.keys(a.used).length > 0 && (
                  <div className="anode-tools">
                    {Object.entries(a.used).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([tool, n]) => (
                      <span key={tool} className="atool">{tool.replace(/_/g, " ")} <b>{n}</b></span>
                    ))}
                  </div>
                )}
                {a.calls === 0 && <div className="hint">Has not run yet.</div>}
              </div>
            ))}
          </div>

          {data.links.length > 0 && (
            <div className="amap-links">
              <div className="amap-legend">
                Lines mean two agents share a permission or a knowledge pack. They do
                not talk to each other — agents run one at a time and never contact one another.
              </div>
              <ul>
                {data.links.map((l, i) => {
                  const a = data.agents.find((x) => x.id === l.a);
                  const b = data.agents.find((x) => x.id === l.b);
                  if (!a || !b) return null;
                  return (
                    <li key={i}>
                      <span className="alink-a">{a.icon} {a.name}</span>
                      <span className="alink-wire" aria-hidden="true" />
                      <span className="alink-a">{b.icon} {b.name}</span>
                      <span className="hint">
                        {[l.tools.length ? `${l.tools.length} shared permission${l.tools.length === 1 ? "" : "s"}` : "",
                          l.packs.length ? `${l.packs.length} shared pack${l.packs.length === 1 ? "" : "s"}` : ""]
                          .filter(Boolean).join(" · ")}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {data.recent.length > 0 && (
            <ol className="amap-feed">
              {[...data.recent].reverse().slice(0, 12).map((e, i) => (
                <li key={i} className={e.ok === false ? "bad" : ""}>
                  <span className="num feedtime">{new Date(e.at).toLocaleTimeString()}</span>
                  <strong>{e.agent_name || "an agent"}</strong>
                  <span>{KIND[e.kind] ?? e.kind}{e.tool ? ` — ${e.tool.replace(/_/g, " ")}` : ""}</span>
                  {e.detail && <span className="hint feeddetail">{e.detail}</span>}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
