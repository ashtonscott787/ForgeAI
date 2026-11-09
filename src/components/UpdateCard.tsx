import { fmtBytes, type UpdateInfo, type UpdateProgress } from "../lib/ipc";

/**
 * The update notice. It states the version, what changed and how large the
 * download is before anything is fetched, and it never installs a file that
 * failed its checksum.
 */
export function UpdateCard({
  info,
  progress,
  phase,
  error,
  onUpdate,
  onLater,
  onSkip,
  onReveal,
}: {
  info: UpdateInfo;
  progress: UpdateProgress | null;
  phase: "idle" | "downloading" | "verifying" | "ready" | "installing";
  error: string | null;
  onUpdate: () => void;
  onLater: () => void;
  onSkip: () => void;
  onReveal?: () => void;
}) {
  const pct = progress && progress.total > 0 ? Math.min(100, (progress.received / progress.total) * 100) : 0;

  return (
    <div className="updatecard">
      <div className="uhead">
        <div>
          <div className="utitle">Forge AI {info.version} is available</div>
          <div className="usub num">
            You have {info.current}
            {info.asset ? ` · ${fmtBytes(info.asset.bytes)} download` : ""}
          </div>
        </div>
        {phase === "idle" && (
          <button className="conv-x" title="Dismiss" onClick={onLater}>
            ×
          </button>
        )}
      </div>

      {info.notes && <div className="unotes">{info.notes.slice(0, 900)}</div>}

      {!info.installable && info.reason && <div className="banner warn">{info.reason}</div>}
      {error && (
        <div className="banner err">
          {error}
          {onReveal && (
            <div className="uactions" style={{ marginTop: 8 }}>
              <button className="ghostbtn" onClick={onReveal}>
                Show me the download
              </button>
            </div>
          )}
        </div>
      )}

      {phase === "downloading" && (
        <div className="dlwrap">
          <div className="pbar">
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className="dlmeta num">
            {progress ? `${fmtBytes(progress.received)} of ${fmtBytes(progress.total)}` : "Starting…"}
          </div>
        </div>
      )}
      {phase === "verifying" && <div className="sub">Checking the download against its published checksum…</div>}
      {phase === "installing" && <div className="sub">Installing and restarting…</div>}

      {phase === "idle" && (
        <div className="uactions">
          <button className="primary" disabled={!info.installable} onClick={onUpdate}>
            Update now
          </button>
          <button className="ghostbtn" onClick={onLater}>
            Remind me later
          </button>
          <button className="ghostbtn" onClick={onSkip}>
            Skip this version
          </button>
        </div>
      )}
      {phase === "ready" && (
        <div className="uactions">
          <button className="primary" onClick={onUpdate}>
            Restart to finish
          </button>
          <button className="ghostbtn" onClick={onLater}>
            Later
          </button>
        </div>
      )}
    </div>
  );
}
