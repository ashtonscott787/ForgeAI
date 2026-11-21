import { useEffect, useState } from "react";

/**
 * What Forge AI shows while it is getting ready.
 *
 * It reports real stages rather than running a bar on a timer: the hardware
 * check, the model list and the settings load each actually happen, and a
 * decorative progress bar that finishes before the app does is a small lie
 * people learn to distrust. If a stage is slow, the screen says which one.
 */
const STAGES = [
  { id: "settings", label: "Reading your settings" },
  { id: "hardware", label: "Looking at this machine" },
  { id: "models", label: "Finding your models" },
  { id: "ready", label: "Ready" },
] as const;

export type BootStage = (typeof STAGES)[number]["id"];

export function Boot({ stage, error, onRetry }: { stage: BootStage; error?: string | null; onRetry?: () => void }) {
  const at = STAGES.findIndex((s) => s.id === stage);
  const [slow, setSlow] = useState(false);

  // Nothing is said about being slow until it is actually slow.
  useEffect(() => {
    setSlow(false);
    const t = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(t);
  }, [stage]);

  return (
    <div className="boot" role="status" aria-live="polite" aria-label="Starting Forge AI">
      <div className="boot-mark" aria-hidden="true">
        <span className="boot-ring" />
        <span className="boot-ring two" />
        <span className="boot-core" />
      </div>

      <div className="boot-name">Forge AI</div>
      <div className="boot-sub">Everything runs on this computer.</div>

      {error ? (
        <div className="boot-error">
          <p>{error}</p>
          {onRetry && <button type="button" className="ghostbtn" onClick={onRetry}>Try again</button>}
        </div>
      ) : (
        <>
          <ol className="boot-stages">
            {STAGES.filter((s) => s.id !== "ready").map((s, i) => (
              <li key={s.id} className={i < at ? "done" : i === at ? "now" : ""}>
                <span className="boot-tick" aria-hidden="true">{i < at ? "✓" : i === at ? "" : ""}</span>
                {s.label}
              </li>
            ))}
          </ol>
          {slow && stage !== "ready" && (
            <p className="boot-slow">
              {stage === "models" ? "Reading model files takes a moment the first time." : "Still working."}
            </p>
          )}
        </>
      )}
    </div>
  );
}
