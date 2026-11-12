import { useEffect, useRef, useState } from "react";
import { api, type WebResult } from "../lib/ipc";

/**
 * A live search, run once, with its sources shown as links.
 *
 * The whole point is that the citations are real: each one is the URL the
 * result came from, and a failure is shown as a failure. A search that returned
 * nothing and a search that did not run are different things and are said
 * differently, because a model told "no results" will answer from memory and
 * present it as researched.
 */
export function SearchCard({
  query,
  disabled,
  onResult,
}: {
  query: string;
  disabled?: boolean;
  onResult: (text: string) => void;
}) {
  const [run, setRun] = useState<WebResult | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    // An old transcript being reopened must not re-run a search.
    if (started.current || disabled) return;
    started.current = true;
    setBusy(true);
    void api
      .webSearch(query)
      .then((r) => {
        setRun(r);
        if (r.ok && r.context) onResult(r.context);
        else if (r.ok) onResult(`A search for "${query}" returned no results. Say so rather than answering from memory.`);
        else onResult(`The search for "${query}" did not run: ${r.error}. Do not answer as though it had; say that it failed.`);
      })
      .catch((e) => setRun({ ok: false, provider: "", query, results: [], found: 0, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => setBusy(false));
  }, [query, disabled, onResult]);

  if (disabled && !run && !busy) {
    return <div className="searchcard hint">Only the newest reply can run a search.</div>;
  }

  return (
    <div className="searchcard">
      <div className="searchcard-h">
        <span aria-hidden="true">⌕</span>
        <span className="searchcard-q">{query}</span>
        <span className="hint">
          {busy ? "Searching…" : run?.ok ? `${run.found} result${run.found === 1 ? "" : "s"} · ${run.label}` : "did not run"}
        </span>
      </div>

      {!busy && run && !run.ok && (
        <div className="searchcard-fail" role="status">
          {run.error}
          {run.kind === "no_key" && " You can choose a different engine in Settings."}
        </div>
      )}

      {!busy && run?.ok && run.found === 0 && <div className="hint searchcard-pad">{run.note}</div>}

      {run?.ok && run.results.length > 0 && (
        <ol className="searchcard-list">
          {run.results.map((r, i) => (
            <li key={r.url}>
              <button
                type="button"
                className="linkbtn searchcard-title"
                onClick={() => void api.openExternal(r.url).catch(() => undefined)}
              >
                [{i + 1}] {r.title}
              </button>
              <span className="searchcard-host num">{r.source}</span>
              {r.snippet && <div className="hint">{r.snippet}</div>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
