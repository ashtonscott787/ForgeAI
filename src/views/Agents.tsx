import { useEffect, useRef, useState } from "react";
import { api, type Agent, type AgentTool, type MachineCapability } from "../lib/ipc";
import { streamChat, type ChatMessage } from "../lib/chat";

/**
 * Agents: a saved worker, run one task at a time.
 *
 * The loop is deliberately plain. The agent is given a goal, it answers with a
 * plan and at most one tool call at a time, the call is checked by the main
 * process — not here, and not by the model — and anything that changes the
 * world waits for a person. Results are fed back as a new turn, so the model
 * sees what actually happened rather than what it hoped would happen.
 */
type Entry =
  | { kind: "said"; text: string }
  | { kind: "tool"; tool: string; input: string; state: "waiting" | "done" | "refused"; result?: string }
  | { kind: "note"; text: string };

const MAX_TURNS = 8;

export function Agents({
  installed,
  self,
}: {
  /** Model files actually on disk, so an agent runs on one that exists. */
  installed: { file_name: string; label: string }[];
  self: MachineCapability | null;
}) {
  const [list, setList] = useState<Agent[]>([]);
  const [tools, setTools] = useState<AgentTool[]>([]);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [running, setRunning] = useState<Agent | null>(null);
  const [goal, setGoal] = useState("");
  const [log, setLog] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [advice, setAdvice] = useState<{ ok: boolean; warn?: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<{ tool: string; input: string } | null>(null);
  const stop = useRef(false);

  const load = () => void api.agentList().then(setList).catch(() => undefined);
  useEffect(() => {
    load();
    void api.agentTools().then(setTools).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (self) void api.agentAdvice({ usable_bytes: self.usable_model_bytes }).then(setAdvice).catch(() => undefined);
  }, [self?.usable_model_bytes]);

  const save = (a: Agent) => void api.agentSave(a).then(() => { load(); setEditing(null); }).catch(() => undefined);

  /** One pass: ask the model, run at most one tool, feed the result back. */
  async function runGoal(agent: Agent, text: string) {
    stop.current = false;
    setBusy(true);
    setLog([{ kind: "note", text: `Goal: ${text}` }]);
    try {
      const { system } = await api.agentPrompt(agent.id);
      // The engine serves one model at a time, so the agent's own model is
      // loaded before the loop starts rather than whatever happened to be up.
      const file = agent.model || installed[0]?.file_name || "";
      if (!file) { setLog((l) => [...l, { kind: "note", text: "No model is installed, so there is nothing to run this on." }]); return; }
      let base = "";
      try {
        const st = await api.ensureEngine(file);
        base = st.base_url;
      } catch (e) {
        setLog((l) => [...l, { kind: "note", text: `The model could not start: ${e instanceof Error ? e.message : String(e)}` }]);
        return;
      }
      if (!base) { setLog((l) => [...l, { kind: "note", text: "The model did not start." }]); return; }
      const turns: ChatMessage[] = [{ role: "system", content: system }, { role: "user", content: text }];

      for (let turn = 0; turn < MAX_TURNS && !stop.current; turn++) {
        let reply = "";
        await new Promise<void>((resolve) => {
          streamChat(base, turns, {
            onToken: (t: string) => { reply += t; },
            onDone: () => resolve(),
            onError: (e: string) => { reply = reply || `The model could not answer: ${e}`; resolve(); },
          });
        });
        if (stop.current) break;

        const acts = parseActs(reply);
        const said = reply.replace(/```forge-act[\s\S]*?```/g, "").trim();
        if (said) setLog((l) => [...l, { kind: "said", text: said }]);
        turns.push({ role: "assistant", content: reply });

        if (!acts.length) break;
        const act = acts[0]!;

        // Asked for, not yet allowed. The main process decides.
        let res = await api.agentAct({ id: agent.id, tool: act.tool, input: act.input });
        if (res.needs_approval) {
          setPending({ tool: act.tool, input: act.input });
          setLog((l) => [...l, { kind: "tool", tool: act.tool, input: act.input, state: "waiting" }]);
          const yes = await waitForApproval();
          setPending(null);
          if (!yes) {
            setLog((l) => l.map((e, i) => (i === l.length - 1 && e.kind === "tool" ? { ...e, state: "refused", result: "You said no." } : e)));
            turns.push({ role: "user", content: `The person refused ${act.tool}. Do not try it again; carry on without it or stop and say why.` });
            continue;
          }
          res = await api.agentAct({ id: agent.id, tool: act.tool, input: act.input, approved: true });
        }

        const outcome = res.ok ? (res.result ?? "") : `Failed: ${res.error ?? "unknown"}`;
        setLog((l) => {
          const last = l[l.length - 1];
          const row: Entry = { kind: "tool", tool: act.tool, input: act.input, state: res.ok ? "done" : "refused", result: outcome };
          return last && last.kind === "tool" && last.state === "waiting" ? [...l.slice(0, -1), row] : [...l, row];
        });
        turns.push({ role: "user", content: `Result of ${act.tool}:\n${outcome}` });
      }
      if (!stop.current) setLog((l) => [...l, { kind: "note", text: "Finished." }]);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const approver = useRef<((ok: boolean) => void) | null>(null);
  const waitForApproval = () => new Promise<boolean>((r) => { approver.current = r; });
  const answer = (ok: boolean) => { approver.current?.(ok); approver.current = null; };

  return (
    <>
      <div className="phead">
        <h2>Agents</h2>
        <p>A saved worker: a name, a job, the rules it follows, and exactly what it is allowed to do.</p>
      </div>
      <div className="scroll">
        <div className="pbody">
          {advice && !advice.ok && <div className="banner warn" role="status">{advice.text}</div>}
          {advice?.warn && <div className="banner" role="status">{advice.text}</div>}

          <div className="sharerow">
            <button className="ghostbtn" onClick={() => setEditing({ id: "", name: "New agent", role: "", instructions: "", model: null, tools: [], preapproved: [], updated: 0 } as Agent)}>New agent</button>
            <button className="ghostbtn" onClick={() => void api.agentImport().then(load)}>Import</button>
            {!list.some((x) => x.name.startsWith("Forge AI")) && installed.length > 0 && (
              <button
                className="ghostbtn"
                onClick={() => void api.agentCreateForge(installed[0]?.file_name).then(load).catch(() => undefined)}
              >
                Add the Forge AI assistant
              </button>
            )}
          </div>

          {list.length === 0 && (
            <p className="hint">
              No agents yet. An agent is a model you already have, with a job and a list of what it
              may do. “Add the Forge AI assistant” sets one up over your installed model, named after
              its size — it is a configuration, not a model that has been trained on anything.
            </p>
          )}

          <ul className="packlist">
            {list.map((a) => (
              <li key={a.id} className="packrow">
                <div className="packmain">
                  <span className="packname">{a.name}</span>
                  <span className="hint">{a.role || "no role set"} · {a.tools.length} permission{a.tools.length === 1 ? "" : "s"}</span>
                </div>
                <div className="packacts">
                  <button className="ghostbtn" onClick={() => { setRunning(a); setLog([]); setGoal(""); }}>Run</button>
                  <button className="ghostbtn" onClick={() => setEditing(a)}>Edit</button>
                  <button className="ghostbtn" onClick={() => void api.agentExport(a.id)}>Export</button>
                  <button className="ghostbtn" onClick={() => void api.agentDelete(a.id).then(load)}>Delete</button>
                </div>
              </li>
            ))}
          </ul>

          {editing && (
            <AgentEditor
              agent={editing}
              tools={tools}
              models={installed}
              onCancel={() => setEditing(null)}
              onSave={save}
            />
          )}

          {running && (
            <div className="packedit">
              <div className="panel-h"><span className="t">Run {running.name}</span>
                <button className="ghostbtn" onClick={() => { stop.current = true; setRunning(null); }}>Close</button>
              </div>
              <textarea
                rows={2}
                placeholder="What should it do? A goal, not a prompt — for example: find this supplier's returns policy and save it to memory."
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
              <div className="sharerow">
                <button className="ghostbtn" disabled={busy || !goal.trim()} onClick={() => void runGoal(running, goal.trim())}>
                  {busy ? "Working…" : "Start"}
                </button>
                {busy && <button className="ghostbtn" onClick={() => { stop.current = true; answer(false); }}>Stop</button>}
              </div>

              {pending && (
                <div className="banner warn approvalrow" role="alertdialog" aria-label="Approval needed">
                  <span><strong>{running.name}</strong> wants to {pending.tool.replace(/_/g, " ")}: <code className="num">{pending.input.slice(0, 160)}</code></span>
                  <span className="packacts">
                    <button className="ghostbtn" onClick={() => answer(true)}>Allow once</button>
                    <button className="ghostbtn" onClick={() => answer(false)}>No</button>
                  </span>
                </div>
              )}

              <ol className="agentlog">
                {log.map((e, i) => (
                  <li key={i} className={`agentrow ${e.kind}`}>
                    {e.kind === "said" && <span>{e.text}</span>}
                    {e.kind === "note" && <span className="hint">{e.text}</span>}
                    {e.kind === "tool" && (
                      <span>
                        <strong>{e.tool.replace(/_/g, " ")}</strong>
                        {e.state === "waiting" && " — waiting for you"}
                        {e.state === "refused" && " — not done"}
                        {e.result && <div className="hint agentresult">{e.result.slice(0, 600)}</div>}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function parseActs(text: string) {
  const out: { tool: string; input: string }[] = [];
  for (const m of text.matchAll(/```forge-act\s*\n([\s\S]*?)```/g)) {
    try {
      const d = JSON.parse(m[1] ?? "");
      if (typeof d?.tool === "string" && d.tool.trim()) out.push({ tool: d.tool.trim(), input: String(d.input ?? "") });
    } catch { /* a half-written block is not an action */ }
  }
  return out;
}

function AgentEditor({
  agent, tools, models, onSave, onCancel,
}: {
  agent: Agent;
  tools: AgentTool[];
  models: { file_name: string; label: string }[];
  onSave: (a: Agent) => void;
  onCancel: () => void;
}) {
  const [a, setA] = useState<Agent>(agent);
  const toggle = (id: string) => setA((p) => {
    const on = p.tools.includes(id);
    const next = on ? p.tools.filter((t) => t !== id) : [...p.tools, id];
    // Dropping a tool must drop its pre-approval too, or granting it again
    // would silently come back pre-approved.
    return { ...p, tools: next, preapproved: p.preapproved.filter((t) => next.includes(t)) };
  });
  const togglePre = (id: string) => setA((p) => ({
    ...p,
    preapproved: p.preapproved.includes(id) ? p.preapproved.filter((t) => t !== id) : [...p.preapproved, id],
  }));

  return (
    <div className="packedit" aria-label="Agent settings">
      <div className="panel-h"><span className="t">{agent.id ? `Edit ${agent.name}` : "New agent"}</span></div>
      <label className="fl" htmlFor="ag-name">Name</label>
      <input id="ag-name" value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} placeholder="Bea" />
      <label className="fl" htmlFor="ag-role">What it is for</label>
      <input id="ag-role" value={a.role} onChange={(e) => setA({ ...a, role: e.target.value })} placeholder="handles supplier email" />
      <label className="fl" htmlFor="ag-inst">Standing instructions</label>
      <textarea id="ag-inst" rows={4} value={a.instructions} onChange={(e) => setA({ ...a, instructions: e.target.value })}
        placeholder="How it should sound, and what it must never do." />
      <label className="fl" htmlFor="ag-model">Model</label>
      <select id="ag-model" value={a.model ?? ""} onChange={(e) => setA({ ...a, model: e.target.value || null })}>
        <option value="">Auto</option>
        {models.map((m) => <option key={m.file_name} value={m.file_name}>{m.label}</option>)}
      </select>

      <h4 className="perm-head">What it may do</h4>
      <p className="hint">Nothing is implied. Anything left unticked, it cannot do.</p>
      <ul className="permlist">
        {tools.map((t) => {
          const on = a.tools.includes(t.id);
          return (
            <li key={t.id} className={`permrow${on ? " on" : ""}`}>
              <label className="perm-main">
                <input type="checkbox" checked={on} onChange={() => toggle(t.id)} aria-label={t.label} />
                <span className="perm-label">{t.label}</span>
                {t.changes && <span className="perm-tag">changes something</span>}
              </label>
              {t.changes && on && (
                <label className="perm-pre">
                  <input
                    type="checkbox"
                    checked={a.preapproved.includes(t.id)}
                    onChange={() => togglePre(t.id)}
                    aria-label={`Allow ${t.label} without asking`}
                  />
                  <span>Do this without asking me</span>
                </label>
              )}
            </li>
          );
        })}
      </ul>

      <div className="sharerow">
        <button className="ghostbtn" disabled={!a.name.trim()} onClick={() => onSave(a)}>Save</button>
        <button className="ghostbtn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
