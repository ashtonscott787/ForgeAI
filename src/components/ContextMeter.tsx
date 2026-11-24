import { useEffect, useMemo, useRef, useState } from "react";
import { countAll, measure, pressure, type Piece } from "../lib/context";

/**
 * What is in the context window, laid out so it can be read at a glance.
 *
 * A bar in the proportions of the window itself — so free space is a piece of
 * the picture rather than an afterthought — then a row per part with its own
 * colour, its token count and its share. Pressing the summary line opens it.
 *
 * It says, every time, whether the numbers are measured or estimated. While
 * the engine is running it asks the engine to tokenise each part with the
 * model's own vocabulary, which is exact. With no engine it falls back to
 * counting characters, and says so in the same breath.
 */
const COLOURS: Record<string, string> = {
  messages: "#4f7fd4",
  system: "#c8703c",
  memory: "#4f9a6a",
  skills: "#c9a227",
  attachments: "#8a5fb0",
};

const n = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)}K` : String(x));

export function ContextMeter({
  pieces,
  limit,
  baseUrl,
  apiKey,
  onCompact,
  canCompact,
  compacting,
}: {
  pieces: Piece[];
  limit: number;
  /** The running engine, if there is one. Exact counts come from it. */
  baseUrl?: string | null;
  /** Its key for this launch; the engine refuses a request without one. */
  apiKey?: string;
  onCompact?: () => void;
  canCompact?: boolean;
  compacting?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const token = useRef(0);

  // Tokenising is a request per part, so it is only done while the panel is
  // open and only when what is in it has actually changed.
  const key = useMemo(() => pieces.map((p) => `${p.id}:${p.text.length}`).join("|"), [pieces]);
  useEffect(() => {
    if (!open || !baseUrl) return;
    const mine = (token.current += 1);
    const ac = new AbortController();
    void countAll(baseUrl, pieces, ac.signal, apiKey).then((c) => {
      if (token.current === mine) setCounts(c);
    });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, baseUrl, apiKey, key]);

  const reading = useMemo(() => measure(pieces, limit, counts ?? undefined), [pieces, limit, counts]);
  const state = pressure(reading);
  const pct = limit > 0 ? Math.min(100, (reading.used / limit) * 100) : 0;

  return (
    <div className={`ctx ${state}`}>
      <button className="ctx-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="ctx-pct num">{Math.round(pct)}% used</span>
        <span className="ctx-of num">
          {n(reading.used)} / {n(limit)}
        </span>
        <span className="ctx-chev" aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>

      <div className="ctx-bar" role="img" aria-label={`${Math.round(pct)} percent of the context window used`}>
        {reading.parts
          .filter((p) => p.tokens > 0)
          .map((p) => (
            <span
              key={p.id}
              className="ctx-seg"
              style={{ width: `${p.share * 100}%`, background: COLOURS[p.id] || "#777" }}
            />
          ))}
      </div>

      {open && (
        <>
          <dl className="ctx-rows">
            {reading.parts.map((p) => (
              <div key={p.id}>
                <dt>
                  <span className="ctx-dot" style={{ background: COLOURS[p.id] || "#777" }} aria-hidden="true" />
                  {p.label}
                </dt>
                <dd className="num">{n(p.tokens)}</dd>
                <dd className="num ctx-share">{(p.share * 100).toFixed(1)}%</dd>
              </div>
            ))}
            <div className="ctx-free">
              <dt>
                <span className="ctx-dot empty" aria-hidden="true" />
                Free space
              </dt>
              <dd className="num">{n(reading.free)}</dd>
              <dd className="num ctx-share">{limit > 0 ? ((reading.free / limit) * 100).toFixed(1) : "0"}%</dd>
            </div>
          </dl>

          <p className="hint ctx-how">
            {reading.estimated
              ? "Estimated from the length of the text, because the engine is not running. Expect a few percent either way."
              : "Counted by the engine, using the vocabulary of the model that is loaded."}
          </p>

          {state === "over" && (
            <p className="sheet-bad">
              This is {n(reading.over)} tokens past the window. The oldest messages will be dropped by the engine
              before the model ever sees them.
            </p>
          )}
          {state === "full" && <p className="hint ctx-warn">Nearly full. Replies get worse from here, and then truncate.</p>}

          {onCompact && (
            <div className="sheet-acts left">
              <button className="btn" disabled={!canCompact || compacting} onClick={onCompact}>
                {compacting ? "Summarising…" : "Compact this chat"}
              </button>
              {!canCompact && <span className="hint">Too short to be worth compacting yet.</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
