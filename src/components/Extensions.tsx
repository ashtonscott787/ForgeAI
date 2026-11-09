import { useEffect, useState } from "react";
import { api, type Connector, type Skill } from "../lib/ipc";

/** Skills: named instructions the person writes and switches on. */
export function SkillsPanel() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [editing, setEditing] = useState<Partial<Skill> | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => api.skillsList().then(setSkills).catch((e) => setErr(String(e)));
  useEffect(() => { void refresh(); }, []);

  async function save() {
    if (!editing) return;
    setErr(null);
    try {
      if (editing.id) {
        await api.skillUpdate({ id: editing.id, name: editing.name, description: editing.description, instructions: editing.instructions });
      } else {
        await api.skillAdd({ name: editing.name ?? "", description: editing.description, instructions: editing.instructions ?? "" });
      }
      setEditing(null);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="panel">
      <div className="panel-h"><span className="t">Skills</span></div>
      <div className="panel-b">
        <p className="hint">
          A skill is a set of instructions you write once. Switch it on and Forge AI follows it in every chat.
          Skills are text only: they cannot run code or reach the internet. Connectors do that, below.
        </p>
        {err && <div className="banner err"><div className="errtext">{err}</div></div>}
        {note && <p className="hint">{note}</p>}
        {skills.map((s) => (
          <div key={s.id} className="row">
            <label>
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => void api.skillUpdate({ id: s.id, enabled: e.target.checked }).then(refresh).catch((x) => setErr(String(x)))}
              />{" "}
              <strong>{s.name}</strong>
            </label>
            {s.description && <div className="hint">{s.description}</div>}
            <div className="actions">
              <button className="ghostbtn" onClick={() => setEditing(s)}>Edit</button>
              <button className="ghostbtn" onClick={() => void api.skillDelete(s.id).then(refresh)}>Delete</button>
            </div>
          </div>
        ))}
        {!skills.length && <p className="hint">No skills yet.</p>}
        {editing ? (
          <div className="form">
            <input placeholder="Name, e.g. Plain-English summaries" value={editing.name ?? ""} maxLength={60}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <input placeholder="Short description (optional)" value={editing.description ?? ""} maxLength={200}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            <textarea rows={6} placeholder="Instructions: how the assistant should behave when this skill is on" value={editing.instructions ?? ""} maxLength={8000}
              onChange={(e) => setEditing({ ...editing, instructions: e.target.value })} />
            <div className="actions">
              <button className="primary" onClick={() => void save()}>Save skill</button>
              <button className="ghostbtn" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="actions">
            <button className="ghostbtn" onClick={() => setEditing({ enabled: true })}>New skill</button>
            <button className="ghostbtn" onClick={() => void api.skillsImport().then((r) => { if (r) setNote(`Imported ${r.added} skill${r.added === 1 ? "" : "s"}.`); void refresh(); }).catch((e) => setErr(String(e)))}>Import…</button>
            <button className="ghostbtn" onClick={() => void api.skillsExport().then((p) => p && setNote(`Saved to ${p}`)).catch((e) => setErr(String(e)))}>Export…</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Connectors: HTTPS endpoints the person adds. Only the person can send a request. */
export function ConnectorsPanel() {
  const [items, setItems] = useState<Connector[]>([]);
  const [editing, setEditing] = useState<Partial<Connector & { token: string }> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; text: string } | null>(null);
  const [path, setPath] = useState("");

  const refresh = () => api.connectorsList().then(setItems).catch((e) => setErr(String(e)));
  useEffect(() => { void refresh(); }, []);

  async function save() {
    if (!editing) return;
    setErr(null);
    try {
      const input = {
        name: editing.name ?? "",
        description: editing.description,
        base_url: editing.base_url ?? "",
        auth_header: editing.auth_header || "Authorization",
        token: editing.token || undefined,
      };
      if (editing.id) await api.connectorUpdate({ id: editing.id, ...input });
      else await api.connectorAdd(input);
      setEditing(null);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function send(c: Connector) {
    setErr(null);
    setResult(null);
    try {
      const r = await api.connectorCall(c.id, path, "GET");
      setResult({ id: c.id, text: `HTTP ${r.status}\n${r.body}${r.truncated ? "\n…(cut off at 200 KB)" : ""}` });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="panel">
      <div className="panel-h"><span className="t">Connectors</span></div>
      <div className="panel-b">
        <p className="hint">
          A connector is a service you add by address, such as your own web API. Tokens are kept in the
          computer's keychain. Forge AI sends a request only when you press Send; the model cannot send one.
        </p>
        {err && <div className="banner err"><div className="errtext">{err}</div></div>}
        {items.map((c) => (
          <div key={c.id} className="row">
            <strong>{c.name}</strong> <span className="hint">{c.base_url}{c.has_token ? " · token saved" : ""}</span>
            {c.description && <div className="hint">{c.description}</div>}
            <div className="actions">
              <input placeholder="Path, e.g. /status" value={path} onChange={(e) => setPath(e.target.value)} />
              <button className="ghostbtn" onClick={() => void send(c)}>Send GET</button>
              <button className="ghostbtn" onClick={() => setEditing({ ...c, token: "" })}>Edit</button>
              <button className="ghostbtn" onClick={() => void api.connectorDelete(c.id).then(refresh)}>Delete</button>
            </div>
            {result?.id === c.id && <pre className="hint">{result.text}</pre>}
          </div>
        ))}
        {!items.length && <p className="hint">No connectors yet.</p>}
        {editing ? (
          <div className="form">
            <input placeholder="Name" value={editing.name ?? ""} maxLength={60} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <input placeholder="Address, e.g. https://api.example.com" value={editing.base_url ?? ""} onChange={(e) => setEditing({ ...editing, base_url: e.target.value })} />
            <input placeholder="Header for the token (default Authorization)" value={editing.auth_header ?? ""} onChange={(e) => setEditing({ ...editing, auth_header: e.target.value })} />
            <input type="password" placeholder={editing.id ? "New token (leave blank to keep)" : "Token (optional)"} value={editing.token ?? ""} onChange={(e) => setEditing({ ...editing, token: e.target.value })} />
            <input placeholder="Description (optional)" value={editing.description ?? ""} maxLength={200} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            <div className="actions">
              <button className="primary" onClick={() => void save()}>Save connector</button>
              <button className="ghostbtn" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="ghostbtn" onClick={() => setEditing({ auth_header: "Authorization" })}>New connector</button>
        )}
      </div>
    </div>
  );
}
