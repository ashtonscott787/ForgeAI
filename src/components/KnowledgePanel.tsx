import { useEffect, useState } from "react";
import { api, type KnowledgePack, type Settings } from "../lib/ipc";

/**
 * Your own material, searched and handed to the model when it answers.
 *
 * The wording here matters. This is not weight training, and saying it was
 * would be a lie a person could only discover by being let down. It keeps your
 * text, finds the passages that match the question, and puts them in the
 * prompt — which is what actually makes a model answer from your material on a
 * laptop, and is undone the moment a pack is switched off.
 */
export function KnowledgePanel({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const [packs, setPacks] = useState<KnowledgePack[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => void api.knowledgeList().then(setPacks).catch(() => undefined);
  useEffect(load, []);

  const active = settings.knowledge_active ?? [];
  const setActive = (ids: string[]) => {
    const next = { ...settings, knowledge_active: ids };
    onChange(next);
    void api.setSettings(next).catch(() => undefined);
  };
  const toggle = (id: string) => setActive(active.includes(id) ? active.filter((x) => x !== id) : [...active, id]);

  const run = async (what: Promise<unknown>, after = "") => {
    setBusy(true);
    setNote("");
    try { await what; if (after) setNote(after); load(); }
    catch (e) { setNote(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const chosen = packs.find((p) => p.id === editing) ?? null;

  return (
    <div className="panel" aria-label="Your own knowledge">
      <div className="panel-h">
        <span className="t">Teach it about your own things</span>
        <button type="button" className="ghostbtn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Open"}
        </button>
      </div>
      {open && (
        <div className="panel-b">
          <p className="hint">
            Add your own documents and notes to a pack. When a pack is switched on,
            Forge AI finds the passages that match your question and gives them to
            the model before it answers, with the document each came from.
          </p>
          <p className="hint">
            This does not retrain the model and does not change its weights — that
            needs far more memory than a laptop has, and a badly retrained model is
            worse than the one it started as. Switching a pack off undoes it
            completely. Packs stay on this computer unless you export one.
          </p>

          {note && <div className="banner warn" role="status">{note}</div>}

          <div className="sharerow">
            <button type="button" className="ghostbtn" disabled={busy}
              onClick={() => void run(api.knowledgeCreate({ name: `Pack ${packs.length + 1}` }), "")}>
              New pack
            </button>
            <button type="button" className="ghostbtn" disabled={busy}
              onClick={() => void run(api.knowledgeImport().then((r) => { if (r.cancelled) throw new Error(""); }), "Imported.")}>
              Import a pack
            </button>
          </div>

          {packs.length === 0 && <p className="hint">No packs yet. Make one, then add files or paste text into it.</p>}

          <ul className="packlist">
            {packs.map((p) => (
              <li key={p.id} className="packrow">
                <label className="packmain">
                  <input type="checkbox" checked={active.includes(p.id)} onChange={() => toggle(p.id)} aria-label={`Use ${p.name} when answering`} />
                  <span className="packname">{p.name}</span>
                  <span className="hint num">{p.documents.length} document{p.documents.length === 1 ? "" : "s"} · {p.passages} passage{p.passages === 1 ? "" : "s"}</span>
                </label>
                <div className="packacts">
                  <button type="button" className="ghostbtn" onClick={() => setEditing(editing === p.id ? null : p.id)}>
                    {editing === p.id ? "Done" : "Edit"}
                  </button>
                  <button type="button" className="ghostbtn" disabled={busy} onClick={() => void run(api.knowledgeExport(p.id), "")}>Export</button>
                  <button type="button" className="ghostbtn" disabled={busy} onClick={() => void run(api.knowledgeDelete(p.id), "")}>Delete</button>
                </div>
              </li>
            ))}
          </ul>

          {chosen && (
            <div className="packedit">
              <div className="panel-h"><span className="t">{chosen.name}</span></div>
              <div className="sharerow">
                <button type="button" className="ghostbtn" disabled={busy}
                  onClick={() => void run(
                    api.knowledgeAddFiles(chosen.id).then((r) => { if (r.failed?.length) throw new Error(`Not added: ${r.failed.join("; ")}`); }),
                    "",
                  )}>
                  Add files
                </button>
              </div>
              <label className="fl" htmlFor="kp-name">Or paste text</label>
              <input id="kp-name" placeholder="What is this? e.g. Supplier terms" value={name} onChange={(e) => setName(e.target.value)} />
              <textarea rows={4} placeholder="Paste the text here" value={text} onChange={(e) => setText(e.target.value)} />
              <button
                type="button"
                className="ghostbtn"
                disabled={busy || !text.trim()}
                onClick={() => void run(
                  api.knowledgeAddText({ id: chosen.id, name: name.trim() || "Pasted text", text }).then(() => { setText(""); setName(""); }),
                  "",
                )}
              >
                Add this text
              </button>

              <ul className="packdocs">
                {chosen.documents.map((d) => (
                  <li key={d.id}>
                    <span>{d.name}</span>
                    <span className="hint num">{d.chunks} passage{d.chunks === 1 ? "" : "s"}</span>
                    <button type="button" className="ghostbtn" disabled={busy}
                      onClick={() => void run(api.knowledgeRemoveDoc({ id: chosen.id, doc_id: d.id }), "")}>Remove</button>
                  </li>
                ))}
                {chosen.documents.length === 0 && <li className="hint">Nothing in this pack yet.</li>}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
