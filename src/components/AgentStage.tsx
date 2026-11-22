import { useEffect, useMemo, useRef, useState } from "react";
import { PLACES, placeOf } from "../lib/places";
import type { AgentActivity } from "../lib/ipc";

/**
 * The agents at work, as it happened.
 *
 * Each recorded step becomes a bubble that leaves the agent, travels to the
 * place the tool belongs to, and says what it was doing when it arrives. Run
 * live, the newest step appears as it is recorded; pressed, it replays the
 * recent history in order so the shape of a run can be watched rather than
 * read out of a list.
 *
 * It is a picture of the log and nothing more. A bubble exists because a tool
 * call was recorded; its label is that call's own words. Nothing is
 * interpolated to make the motion look busier than the work was, and agents
 * are never drawn travelling to each other, because they never do.
 */
interface Step {
  key: string;
  agent: string;
  place: string;
  label: string;
  ok: boolean | null;
  at: number;
}

const TRAVEL_MS = 2600;

function stepsFrom(recent: AgentActivity["recent"]): Step[] {
  const out: Step[] = [];
  for (const e of recent) {
    if (e.kind !== "tool" || !e.tool) continue;
    const place = placeOf(e.tool);
    if (!place) continue;
    out.push({
      key: `${e.at}-${e.agent_id}-${e.tool}`,
      agent: e.agent_name,
      place,
      label: e.tool.replace(/_/g, " "),
      ok: e.ok,
      at: e.at,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

export function AgentStage({ data }: { data: AgentActivity }) {
  const steps = useMemo(() => stepsFrom(data.recent || []), [data.recent]);
  const [flying, setFlying] = useState<Step[]>([]);
  const seen = useRef<Set<string>>(new Set());
  const [replaying, setReplaying] = useState(false);

  // Anything recorded since the last look flies now. On the first look
  // nothing flies: a page that opens with a burst of old traffic is a lie
  // about what is happening at this moment.
  const first = useRef(true);
  useEffect(() => {
    const fresh = steps.filter((s) => !seen.current.has(s.key));
    for (const s of fresh) seen.current.add(s.key);
    if (first.current) { first.current = false; return; }
    if (!fresh.length) return;
    setFlying((f) => [...f, ...fresh]);
    const t = setTimeout(() => {
      setFlying((f) => f.filter((x) => !fresh.some((n) => n.key === x.key)));
    }, TRAVEL_MS);
    return () => clearTimeout(t);
  }, [steps]);

  function replay() {
    if (replaying || !steps.length) return;
    setReplaying(true);
    const timers: number[] = [];
    steps.forEach((s, i) => {
      const key = `${s.key}-replay-${i}`;
      timers.push(window.setTimeout(() => setFlying((f) => [...f, { ...s, key }]), i * 420));
      timers.push(window.setTimeout(() => setFlying((f) => f.filter((x) => x.key !== key)), i * 420 + TRAVEL_MS));
    });
    timers.push(window.setTimeout(() => setReplaying(false), steps.length * 420 + TRAVEL_MS));
  }

  const visited = PLACES.filter((p) => steps.some((s) => s.place === p.id));
  const lanes = visited.length ? visited : PLACES.slice(0, 2);

  return (
    <div className="stage">
      <div className="stage-h">
        <strong>Agents at work</strong>
        <button className="ghostbtn small" disabled={!steps.length || replaying} onClick={replay}>
          {replaying ? "Replaying…" : "Replay the last run"}
        </button>
      </div>

      {!steps.length ? (
        <p className="hint">
          Nothing has run yet. When an agent searches, reads a file or writes one, it will cross this
          space as it happens.
        </p>
      ) : (
        <div className="stage-floor" style={{ ["--lanes" as string]: String(lanes.length) }}>
          <div className="stage-from">Agents</div>
          {lanes.map((p) => (
            <div key={p.id} className="stage-lane">
              <span className="stage-dot" />
              <span className="stage-place">{p.name}</span>
            </div>
          ))}

          {flying.map((s) => {
            const lane = Math.max(0, lanes.findIndex((p) => p.id === s.place));
            return (
              <span
                key={s.key}
                className={`stage-bubble${s.ok === false ? " failed" : ""}`}
                style={{ ["--lane" as string]: String(lane), ["--lanes" as string]: String(lanes.length) }}
              >
                <b>{s.agent}</b> {s.label}
              </span>
            );
          })}
        </div>
      )}

      <p className="hint stage-note">
        A bubble is one recorded step, labelled with the tool it used. Agents never travel to each
        other, because they never contact each other.
      </p>
    </div>
  );
}
