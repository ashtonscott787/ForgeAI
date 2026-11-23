import type { AgentEvent } from "./ipc";

/**
 * A run drawn the way a branching history is drawn.
 *
 * Work does not happen in a line. Something is being written, a search goes
 * off to one side, a file is read on another, and each comes back before the
 * work carries on. That shape is familiar from a commit graph, and it is the
 * right picture for a run too: a trunk with branches leaving it and rejoining.
 *
 * What is drawn is the recorded log and nothing else. A branch exists because
 * a tool call was recorded; it rejoins because a later step was recorded; it
 * ends in a cross because that call was recorded as failed. Nothing is
 * invented to make the picture busier than the run was.
 *
 * What it is NOT: a timeline. The log records when each step started and not
 * how long it took, so the horizontal spacing is the order of steps, evenly
 * spaced. Reading the width of a branch as a duration would be reading
 * something that is not there.
 */

export interface Node {
  /** Position along the trunk, counting from zero. */
  x: number;
  label: string;
  at: number;
}

export interface Branch {
  key: string;
  /** Trunk position it leaves from. */
  from: number;
  /** Trunk position it rejoins at. Equal to `from` when it never came back. */
  to: number;
  /** Which side and how far out: -2..-1 above the trunk, 1..2 below it. */
  lane: number;
  label: string;
  agent: string;
  /** null while a step is still open — recorded, no outcome yet. */
  ok: boolean | null;
}

export interface Graph {
  nodes: Node[];
  branches: Branch[];
  /** How many trunk positions there are. */
  length: number;
}

const LANES = [-1, 1, -2, 2];

/**
 * Turns recorded steps into a trunk and its branches.
 *
 * Every step is both a point on the trunk and a branch away from it: the
 * trunk is the run going on, and the branch is the piece of work that went
 * off to do one thing. A step that failed does not rejoin.
 */
export function graphOf(events: AgentEvent[], limit = 12): Graph {
  const steps = events
    .filter((e) => e.kind === "tool" && e.tool)
    .slice()
    .sort((a, b) => a.at - b.at)
    .slice(-limit);

  const nodes: Node[] = [];
  const branches: Branch[] = [];

  steps.forEach((e, i) => {
    const label = String(e.tool).replace(/_/g, " ");
    nodes.push({ x: i, label, at: e.at });
    branches.push({
      key: `${e.at}-${e.agent_id}-${e.tool}-${i}`,
      from: i,
      // A failure is where the branch stops. It did not come back with
      // anything, so drawing it rejoining the trunk would be a lie about it.
      to: e.ok === false ? i : i + 1,
      lane: LANES[i % LANES.length]!,
      label,
      agent: e.agent_name,
      ok: e.ok,
    });
  });

  // One past the last step, so the final branch has somewhere to rejoin and
  // the trunk visibly carries on afterwards.
  return { nodes, branches, length: steps.length ? steps.length + 1 : 0 };
}

/** Where a trunk position sits, in pixels, for a graph drawn `width` wide. */
export function xAt(i: number, length: number, width: number, pad = 28): number {
  if (length <= 1) return pad;
  return pad + (i * (width - pad * 2)) / (length - 1);
}
