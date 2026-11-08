import { useEffect, useState } from "react";
import { api, type Memory } from "../lib/ipc";

/**
 * Everything Forge AI remembers, in one place, with nothing hidden. The model
 * can propose a memory in chat; only a person saves one here.
 */
export function MemoryView() {
  const [items, setItems] = useState<Memory[]>([]);
  const [text, setText] = useState("");
  const [scope, setScope] = useState<"personal" | "project">("personal");
  const [project, setProject] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () => void api.memoryList().then(setItems).catch(() => undefined);
  useEffect(refresh, []);

  async function run(fn: () => Promise<unknown>, message?: string) {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (message) setNotice(message);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const personal = items.filter((m) => m.scope === "personal");
  const byProject = items.filter((m) => m.scope === "project");

  const card = (m: Memory) => (
    <div key={m.id} className={`memrow${m.pinned ? " pinned" : ""}`}>
      <div className="memmain">
        <div className="memtext">{m.text}</div>
        <div className="mcard-sub num">
          {m.scope === "project" ? `${m.project || "unnamed project"} · ` : ""}
          added {new Date(m.created).toLocaleDateString()}
          {m.source && m.source !== "you" ? ` · from ${m.source}` : ""}
          {m.expires ? ` · expires ${new Date(m.expires).toLocaleDateString()}` : ""}
        </div>
      </div>
      <button
        className="ghostbtn"
        title={m.pinned ? "Unpin" : "Pin so it is always included"}
        onClick={() => void run(() => api.memoryUpdate({ id: m.id, pinned: !m.pinned }))}
      >
        {m.pinned ? "Unpin" : "Pin"}
      </button>
      <button className="ghostbtn" onClick={() => void run(() => api.memoryDelete(m.id))}>
        Forget
      </button>
    </div>
  );

  return (
    <div className="scroll pane">
      <div className="pane-head">
        <div>
          <h2>Memory</h2>
          <p className="sub">
            Facts Forge AI carries between conversations. They are stored on this computer only, and
            the pinned ones plus the most recent are added to each prompt — not the whole list, which
            would crowd out the conversation.
          </p>
        </div>
        <div className="rowbtns">
          <button className="ghostbtn" onClick={() => void run(() => api.memoryExport(), "Exported.")}>
            Export
          </button>
          <button className="ghostbtn" onClick={() => void run(() => api.memoryImport(false), "Imported.")}>
            Import
          </button>
        </div>
      </div>

      {error && <div className="banner err">{error}</div>}
      {notice && <div className="banner">{notice}</div>}

      <div className="remform">
        <input
          className="inp"
          placeholder="Something worth remembering — “I prefer short, direct emails”"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select className="qsel" value={scope} onChange={(e) => setScope(e.target.value as "personal" | "project")}>
          <option value="personal">Personal</option>
          <option value="project">Project</option>
        </select>
        {scope === "project" && (
          <input className="inp narrow" placeholder="Project" value={project} onChange={(e) => setProject(e.target.value)} />
        )}
        <button
          className="primary"
          disabled={!text.trim()}
          onClick={() =>
            void run(async () => {
              await api.memoryAdd({ text: text.trim(), scope, project });
              setText("");
            })
          }
        >
          Remember
        </button>
      </div>

      <h3 className="secthead">Personal · {personal.length}</h3>
      {personal.length === 0 && <p className="sub">Nothing yet.</p>}
      <div className="remlist">{personal.map(card)}</div>

      <h3 className="secthead">Project · {byProject.length}</h3>
      {byProject.length === 0 && <p className="sub">Nothing yet.</p>}
      <div className="remlist">{byProject.map(card)}</div>
    </div>
  );
}
