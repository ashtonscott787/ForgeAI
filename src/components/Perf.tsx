import { useState } from "react";
import type { Perf } from "../lib/chat";

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * What the answer actually cost, measured end to end: the clock starts when
 * Send is pressed and stops when the last token lands, so model loading and
 * queueing are inside the number rather than hidden beside it.
 */
export function PerfLine({ perf }: { perf: Perf }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="perf">
      <button className="perftoggle" onClick={() => setOpen((v) => !v)}>
        Completed in {secs(perf.total_ms)}
        <span className="perfchev">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <dl className="perfgrid num">
          <div><dt>Total</dt><dd>{secs(perf.total_ms)}</dd></div>
          <div><dt>Model</dt><dd>{perf.model}</dd></div>
          <div><dt>Machine</dt><dd>{perf.machine}</dd></div>
          {perf.load_ms > 0 && <div><dt>Model loading</dt><dd>{secs(perf.load_ms)}</dd></div>}
          <div><dt>Time to first token</dt><dd>{secs(perf.first_token_ms)}</dd></div>
          <div><dt>Generating</dt><dd>{secs(perf.generate_ms)}</dd></div>
          <div><dt>Output tokens</dt><dd>{perf.tokens}</dd></div>
          <div><dt>Output speed</dt><dd>{perf.tok_s.toFixed(1)} tok/s</dd></div>
          {perf.context_chars ? (
            <div><dt>Document context</dt><dd>{perf.context_chars.toLocaleString()} characters</dd></div>
          ) : null}
          <div><dt>Ran on</dt><dd>{perf.where === "local" ? "this computer" : "cluster"}</dd></div>
        </dl>
      )}
    </div>
  );
}
