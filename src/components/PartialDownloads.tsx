import { useEffect, useState } from "react";
import { api, fmtBytes, type PartialDownload } from "../lib/ipc";

/**
 * Downloads that stopped partway and were never picked up.
 *
 * Resuming a model download has always worked — the next attempt sends a
 * Range header and carries on from the bytes already on disk. What never
 * happened was anybody being told there was something to resume. A
 * half-downloaded model is invisible: it is not in the model list, because
 * it is not a model yet, and it is not in the downloads list, because
 * nothing is downloading. One sat in a models folder for twelve days
 * holding 720 MB.
 *
 * So it is said out loud, with both answers available: finish it, or get
 * the space back.
 */
const ago = (t: number) => {
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} ago`;
  const hours = Math.floor((Date.now() - t) / 3_600_000);
  return hours >= 1 ? `${hours} hour${hours === 1 ? "" : "s"} ago` : "just now";
};

export function PartialDownloads({ onResume }: { onResume?: (fileName: string) => void }) {
  const [list, setList] = useState<PartialDownload[]>([]);
  // Array.isArray, not a bare assignment: an older main process, or a build
  // that does not know this command, answers null, and `null.length` in a
  // render takes the whole window down rather than hiding one banner.
  const look = () =>
    void api.partialDownloads().then((l) => setList(Array.isArray(l) ? l : [])).catch(() => setList([]));
  useEffect(look, []);

  if (!list.length) return null;

  return (
    <div className="banner warn partials">
      {list.map((p) => (
        <div key={p.part} className="partial">
          <span>
            <b>{p.file_name}</b> stopped partway — {fmtBytes(p.bytes)} downloaded, {ago(p.at)}.
            {p.superseded && " The finished model is already here, so this is just taking up space."}
          </span>
          <span className="partial-acts">
            {!p.superseded && onResume && (
              <button className="ghostbtn small" onClick={() => onResume(p.file_name)}>Finish it</button>
            )}
            <button
              className="ghostbtn small"
              onClick={() => void api.discardPartial(p.part).then(look)}
            >
              Remove, free {fmtBytes(p.bytes)}
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
