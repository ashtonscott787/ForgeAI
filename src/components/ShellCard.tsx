import { useEffect, useState } from "react";
import { api } from "../lib/ipc";

/**
 * A command the assistant would like to run.
 *
 * It does not run it. Pressing the button puts the text in the shell's input
 * box, where it sits until the person presses Run. Two separate deliberate
 * actions, and the model takes neither of them.
 *
 * The card checks the command against the same refusal list the shell uses,
 * so a command that would be refused says so here rather than after somebody
 * has moved it across and pressed a button.
 */
export function ShellCard({
  command,
  why,
  onSend,
}: {
  command: string;
  why: string;
  onSend?: (command: string) => void;
}) {
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => {
    void api.shellCheck(command).then((c) => setRefused(c.allowed ? null : c.why)).catch(() => undefined);
  }, [command]);

  return (
    <div className={`shellcard${refused ? " refused" : ""}`}>
      <div className="shellcard-h">
        <span className="shellcard-tag">Suggested command</span>
        <span className="hint">{why}</span>
      </div>
      <pre className="shellcard-cmd"><code>{command}</code></pre>
      {refused ? (
        <p className="sheet-bad">{refused}</p>
      ) : (
        <div className="shellcard-acts">
          <button className="btn" disabled={!onSend} onClick={() => onSend?.(command)}>
            Put it in the shell
          </button>
          <span className="hint">It is not run until you press Run there.</span>
        </div>
      )}
    </div>
  );
}
