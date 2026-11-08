import { useEffect, useRef, useState } from "react";
import { api, type ResearchResult } from "../lib/ipc";

/**
 * The model asked for a live lookup. This runs it once, shows what came back
 * with its sources, and hands the text to the conversation so the model
 * answers from retrieved material rather than memory.
 */
export function ResearchCard({
  query,
  disabled,
  onResult,
}: {
  query: string;
  disabled?: boolean;
  onResult: (text: string) => void;
}) {
  const [result, setResult] = useState<ResearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    // Nothing runs until the conversation is settled and this is the live turn;
    // an old transcript must not re-bill a search on being reopened.
    if (ran.current || disabled) return;
    ran.current = true;
    setBusy(true);
    void api
      .research(query)
      .then((r) => {
        setResult(r);
        const sources = r.sources
          .slice(0, 8)
          .map((s, i) => `[${i + 1}] ${s.title || s.url}${s.date ? ` (${s.date})` : ""} — ${s.url}`)
          .join("\n");
        onResult(
          `Web results for "${query}" (via ${r.provider}, fetched ${new Date(r.fetched_at).toLocaleString()}):\n\n${r.answer}\n\nSources:\n${sources}\n\nAnswer using these, and cite the numbers.`,
        );
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [query, disabled, onResult]);

  if (disabled && !result && !busy && !error) {
    return (
      <div className="researchcard">
        <div className="rhead">
          <span className="rlabel">Web search</span>
          <span className="rquery">{query}</span>
        </div>
        <div className="sub">Not run — this is an earlier message.</div>
      </div>
    );
  }

  return (
    <div className="researchcard">
      <div className="rhead">
        <span className="rlabel">Live web search</span>
        <span className="rquery">{query}</span>
      </div>
      {busy && <div className="sub">Searching…</div>}
      {error && (
        <div className="banner err">
          {error}
          <div className="sub">The answer below is from the model&rsquo;s own knowledge, not the web.</div>
        </div>
      )}
      {result && (
        <>
          <div className="ranswer">{result.answer.slice(0, 1200)}</div>
          <ol className="rsources">
            {result.sources.slice(0, 8).map((s, i) => (
              <li key={`${s.url}-${i}`}>
                <button className="linkbtn" onClick={() => void api.openExternal(s.url)}>
                  {s.title || s.url}
                </button>
                {s.date && <span className="num"> · {s.date}</span>}
              </li>
            ))}
          </ol>
          <div className="sub num">
            {result.provider} · fetched {new Date(result.fetched_at).toLocaleTimeString()}
          </div>
        </>
      )}
    </div>
  );
}
