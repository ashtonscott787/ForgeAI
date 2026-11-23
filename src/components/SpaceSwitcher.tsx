import { useEffect, useRef, useState } from "react";
import { makeSpace, type Space } from "../lib/spaces";

/**
 * Switching between workspaces, and making a new one.
 *
 * It sits at the top of the sidebar because it governs everything beneath it:
 * the chat list below belongs to whichever workspace is named here, and a new
 * chat joins it.
 *
 * It says plainly what a workspace is not. Somebody who reads "Work" and
 * "Personal" can reasonably assume a wall between them, and there is no wall
 * — only a filter, on one machine, with no password. That sentence is in the
 * panel rather than in documentation nobody opens.
 */
export function SpaceSwitcher({
  spaces,
  current,
  counts,
  onPick,
  onCreate,
  onRename,
  onDelete,
}: {
  spaces: Space[];
  current: string;
  counts: Record<string, number>;
  onPick: (id: string) => void;
  onCreate: (s: Space) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const here = spaces.find((s) => s.id === current) ?? spaces[0]!;

  function create() {
    const clean = name.trim();
    if (!clean) return;
    const s = makeSpace(clean, spaces);
    onCreate(s);
    onPick(s.id);
    setName("");
    setAdding(false);
    setOpen(false);
  }

  return (
    <div className="spaces" ref={box}>
      <button className="space-now" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu">
        <span className="space-dot" style={{ background: here.accent }} aria-hidden="true" />
        <span className="space-name">{here.name}</span>
        <span className="space-chev" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="space-menu" role="menu">
          {spaces.map((s) => (
            <div key={s.id} className={`space-row${s.id === current ? " on" : ""}`}>
              <button
                role="menuitem"
                className="space-pick"
                onClick={() => {
                  onPick(s.id);
                  setOpen(false);
                }}
              >
                <span className="space-dot" style={{ background: s.accent }} aria-hidden="true" />
                <span className="space-name">{s.name}</span>
                <span className="space-count num">{counts[s.id] ?? 0}</span>
              </button>
              {!s.fixed && (
                <>
                  <button
                    className="space-edit"
                    aria-label={`Rename ${s.name}`}
                    onClick={() => {
                      const next = window.prompt("Name for this workspace", s.name);
                      if (next && next.trim()) onRename(s.id, next.trim().slice(0, 32));
                    }}
                  >
                    Rename
                  </button>
                  <button
                    className="space-del"
                    aria-label={`Delete ${s.name}`}
                    onClick={() => onDelete(s.id)}
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          ))}

          {adding ? (
            <div className="space-new">
              <input
                autoFocus
                value={name}
                maxLength={32}
                placeholder="Name it"
                aria-label="Name for the new workspace"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") create();
                  if (e.key === "Escape") setAdding(false);
                }}
              />
              <button className="btn primary small" onClick={create}>Create</button>
            </div>
          ) : (
            <button className="space-add" onClick={() => setAdding(true)}>New workspace</button>
          )}

          <p className="hint space-note">
            Chats are kept apart by workspace. Memory, accounts and models are shared across all of them, and a
            workspace is not a lock: anybody at this computer can switch to it.
          </p>
        </div>
      )}
    </div>
  );
}
