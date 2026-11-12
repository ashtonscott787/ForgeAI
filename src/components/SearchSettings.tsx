import { useEffect, useState } from "react";
import { api, type SearchProvider, type Settings } from "../lib/ipc";

/**
 * Which engine answers a lookup.
 *
 * Each option says plainly what it needs, and one that cannot run right now is
 * marked as such rather than being offered and then failing. No key is ever
 * built in; keys go to the operating system's key store like every other
 * credential here.
 */
export function SearchSettings({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const [list, setList] = useState<SearchProvider[]>([]);
  const [instance, setInstance] = useState("");
  const [chosen, setChosen] = useState("wikipedia");
  const [key, setKey] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    void api.searchProviders().then((r) => {
      setList(r.providers);
      setChosen(r.chosen);
      setInstance(r.instance);
    }).catch(() => undefined);
  useEffect(load, []);

  const save = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    onChange(next);
    void api.setSettings(next).then(load).catch(() => undefined);
  };

  const current = list.find((p) => p.id === chosen);

  return (
    <div className="panel" aria-label="Internet search">
      <div className="panel-h"><span className="t">Internet search</span></div>
      <div className="panel-b">
        <p className="hint">
          Which engine Forge AI uses when it looks something up. Results are shown
          with their links so you can check them, and a search that fails says so
          rather than quietly returning nothing.
        </p>

        <ul className="permlist">
          {list.map((p) => (
            <li key={p.id} className={`permrow${chosen === p.id ? " on" : ""}`}>
              <label className="perm-main">
                <input
                  type="radio"
                  name="search-provider"
                  checked={chosen === p.id}
                  onChange={() => { setChosen(p.id); save({ search_provider: p.id }); }}
                  aria-label={p.label}
                />
                <span className="perm-label">{p.label}</span>
                <span className="perm-tag">
                  {p.needs === null ? "no key needed" : p.needs === "instance" ? "needs an address" : "needs your key"}
                </span>
                {!p.ready && <span className="perm-tag warnText">not set up</span>}
              </label>
            </li>
          ))}
        </ul>

        {chosen === "searxng" && (
          <>
            <label className="fl" htmlFor="searx">SearXNG address</label>
            <input
              id="searx"
              className="setinput"
              placeholder="https://searx.example.org"
              value={instance}
              onChange={(e) => setInstance(e.target.value)}
              onBlur={() => save({ searxng_instance: instance.trim() })}
            />
            <p className="hint">
              Your own instance is the reliable choice: many public ones turn the
              JSON API off, and Forge AI will say so plainly if yours does.
            </p>
          </>
        )}

        {current && current.needs === "key" && (
          <>
            <label className="fl" htmlFor="skey">{current.label} API key</label>
            <div className="sharerow">
              <input
                id="skey"
                className="setinput"
                type="password"
                placeholder={current.ready ? "A key is saved" : `Paste your ${current.label} key`}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <button
                type="button"
                className="ghostbtn"
                disabled={busy || !key.trim()}
                onClick={() => {
                  setBusy(true);
                  setNote("");
                  // Verified by a real search before it is kept.
                  void api.searchKeySave(chosen, key.trim())
                    .then((r) => {
                      setNote(r.ok ? r.detail ?? "Saved." : `Not saved: ${r.error}`);
                      if (r.ok) { setKey(""); load(); }
                    })
                    .catch((e) => setNote(e instanceof Error ? e.message : String(e)))
                    .finally(() => setBusy(false));
                }}
              >
                {busy ? "Checking…" : "Save key"}
              </button>
            </div>
            <p className="hint">Stored in the operating system's key store, never in a file Forge AI can read back in plain text.</p>
          </>
        )}

        {note && <div className="hint">{note}</div>}
      </div>
    </div>
  );
}
