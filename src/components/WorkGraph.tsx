import { useMemo } from "react";
import { graphOf, xAt } from "../lib/worklines";
import type { AgentEvent } from "../lib/ipc";

/**
 * The run drawn as a branching history.
 *
 * A trunk across the middle, and each recorded step leaving it on a curve,
 * doing its one thing and rejoining. It is the shape of a commit graph
 * because it is the same shape of work: carry on, go off, come back.
 *
 * The lines draw themselves in, in order, using stroke-dashoffset, so a run
 * is watched rather than appearing all at once. A step recorded as failed
 * does not rejoin the trunk; it ends in a cross where it stopped.
 *
 * The horizontal axis is the order of steps, not time. The log records when a
 * step began and not how long it ran, so spacing them by duration would mean
 * drawing something nobody measured.
 */
const W = 640;
const H = 150;
const MID = H / 2;
const LANE_H = 30;

export function WorkGraph({ events, title = "How the work went" }: { events: AgentEvent[]; title?: string }) {
  const g = useMemo(() => graphOf(events), [events]);

  if (!g.nodes.length) {
    return (
      <div className="wg">
        <div className="wg-h"><strong>{title}</strong></div>
        <p className="hint">
          Nothing has run yet. Each step an agent takes will leave the line here, do its one thing, and come back.
        </p>
      </div>
    );
  }

  const x = (i: number) => xAt(i, g.length, W);

  return (
    <div className="wg">
      <div className="wg-h"><strong>{title}</strong></div>
      <svg className="wg-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${g.nodes.length} steps, drawn as branches off the main line`}>
        <line className="wg-trunk" x1={x(0)} y1={MID} x2={x(g.length - 1)} y2={MID} />

        {g.branches.map((b, i) => {
          const x0 = x(b.from);
          const x1 = x(b.to);
          const y = MID + b.lane * LANE_H;
          const out = x0 + Math.max(14, (x1 - x0) * 0.35);
          const back = x1 - Math.max(14, (x1 - x0) * 0.35);
          const failed = b.ok === false;
          const d = failed
            ? `M ${x0} ${MID} C ${x0 + 20} ${MID}, ${x0 + 20} ${y}, ${x0 + 46} ${y}`
            : `M ${x0} ${MID} C ${out} ${MID}, ${out} ${y}, ${(x0 + x1) / 2} ${y} S ${back} ${y}, ${x1} ${MID}`;
          const tipX = failed ? x0 + 46 : (x0 + x1) / 2;
          return (
            <g key={b.key} className={`wg-branch${failed ? " failed" : ""}`} style={{ ["--i" as string]: String(i) }}>
              <path className="wg-line" d={d} />
              <circle className="wg-tip" cx={tipX} cy={y} r={4} />
              {failed && (
                <g className="wg-x">
                  <line x1={tipX - 4} y1={y - 4} x2={tipX + 4} y2={y + 4} />
                  <line x1={tipX + 4} y1={y - 4} x2={tipX - 4} y2={y + 4} />
                </g>
              )}
              <text className="wg-label" x={tipX} y={b.lane < 0 ? y - 10 : y + 16} textAnchor="middle">
                {b.label}
              </text>
            </g>
          );
        })}

        {g.nodes.map((node) => (
          <circle key={`${node.at}-${node.x}`} className="wg-node" cx={x(node.x)} cy={MID} r={4.5} />
        ))}
      </svg>
      <p className="hint wg-note">
        One branch is one recorded step, labelled with the tool it used. Left to right is the order they happened in,
        not how long each took — that is not recorded. A branch that stops in a cross is a step that failed.
      </p>
    </div>
  );
}
