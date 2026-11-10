import { useState } from "react";
import type { BrowserActivity as Activity } from "../lib/chat";
import { api } from "../lib/ipc";

const ICON: Record<string, string> = {
  opened: "↗",
  read: "¶",
  captured: "▣",
  searched: "⌕",
};

/**
 * What the browser did for this turn, collapsed to one line.
 *
 * Collapsed by default: the actions are evidence, not the answer, and a person
 * reading the conversation should not have to scroll past them. Everything
 * listed here already happened — nothing in this card starts any work.
 */
export function BrowserActivityCard({ activity }: { activity: Activity }) {
  const [open, setOpen] = useState(false);
  const n = activity.actions.length;
  if (!n && !activity.page) return null;

  return (
    <div className="bact">
      <button
        type="button"
        className="bact-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="bact-globe" aria-hidden="true">🌐</span>
        <span>Used the browser ({n} {n === 1 ? "action" : "actions"})</span>
        <span className={`bact-chev${open ? " on" : ""}`} aria-hidden="true">›</span>
      </button>

      {open && (
        <ul className="bact-list">
          {activity.actions.map((a, i) => (
            <li key={i} className="bact-row">
              <span className="bact-kind" aria-hidden="true">{ICON[a.kind] ?? "·"}</span>
              <span className="bact-label">{a.label}</span>
              {a.detail && <span className="bact-detail">{a.detail}</span>}
            </li>
          ))}
        </ul>
      )}

      {activity.page && (
        <div className="bact-page">
          {activity.page.shot ? (
            <img className="bact-shot" src={activity.page.shot} alt="" />
          ) : (
            <div className="bact-shot bact-shot-blank" aria-hidden="true">🌐</div>
          )}
          <div className="bact-pagemeta">
            <div className="bact-title">{activity.page.title}</div>
            <button
              type="button"
              className="bact-url linkbtn"
              onClick={() => void api.openExternal(activity.page!.url).catch(() => undefined)}
            >
              {activity.page.url.replace(/^https?:\/\//, "").split("/")[0]}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
