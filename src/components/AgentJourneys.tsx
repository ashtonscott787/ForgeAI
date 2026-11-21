import { useMemo, useState } from "react";
import { PLACES, journeys, placesVisited, type AgentLike, type Journey } from "../lib/places";

/**
 * Where the agents have been, drawn.
 *
 * Agents on the left, the places they go on the right, a curve for each
 * journey. The curve's weight is how many trips were made, and a mote travels
 * along it so a busy route is visibly busy. Hovering a curve says what it
 * means in words, because a picture that cannot be read back in a sentence is
 * decoration.
 *
 * Two things it will not draw: a line between two agents, since agents never
 * contact each other, and a line for a journey that was never made.
 */
const ROW = 46;
const PAD = 26;
const LEFT = 150;
const RIGHT = 420;

export function AgentJourneys({ agents }: { agents: AgentLike[] }) {
  const [hover, setHover] = useState<Journey | null>(null);
  const js = useMemo(() => journeys(agents), [agents]);
  const places = useMemo(() => placesVisited(js), [js]);

  const movers = useMemo(() => agents.filter((a) => js.some((j) => j.agent === a.id)), [agents, js]);

  if (!js.length) {
    return (
      <p className="hint ajnone">
        No agent has been anywhere yet. When one searches the web, reads your files or writes a
        document, the journey is drawn here.
      </p>
    );
  }

  const height = Math.max(movers.length, places.length) * ROW + PAD * 2;
  const busiest = Math.max(...js.map((j) => j.trips));
  const yOf = (i: number, n: number) => PAD + (height - PAD * 2) * ((i + 0.5) / n);

  return (
    <div className="ajourneys">
      <svg
        className="ajsvg"
        viewBox={`0 0 ${RIGHT + 150} ${height}`}
        role="img"
        aria-label={`Where agents have been: ${js.map((j) => `${j.agentName} to ${j.placeName}, ${j.trips} trips`).join("; ")}`}
      >
        <defs>
          <linearGradient id="ajflow" x1="0" x2="1">
            <stop offset="0%" stopColor="var(--ember)" stopOpacity="0.05" />
            <stop offset="100%" stopColor="var(--ember)" stopOpacity="0.5" />
          </linearGradient>
        </defs>

        {js.map((j) => {
          const ai = movers.findIndex((a) => a.id === j.agent);
          const pi = places.findIndex((p) => p.id === j.place);
          if (ai < 0 || pi < 0) return null;
          const y1 = yOf(ai, movers.length);
          const y2 = yOf(pi, places.length);
          const mid = (LEFT + RIGHT) / 2;
          const d = `M ${LEFT} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${RIGHT} ${y2}`;
          const on = !hover || hover === j;
          const weight = 1 + (j.trips / busiest) * 4;
          return (
            <g
              key={`${j.agent}-${j.place}`}
              className={`ajlink${hover === j ? " on" : ""}`}
              opacity={on ? 1 : 0.18}
              onMouseEnter={() => setHover(j)}
              onMouseLeave={() => setHover(null)}
            >
              <path d={d} className="ajpath" stroke="url(#ajflow)" strokeWidth={weight} fill="none" />
              {/* Wide, invisible, and the thing the pointer actually hits: a
                  two-pixel line is not a target anybody can reach. */}
              <path d={d} stroke="transparent" strokeWidth={16} fill="none" />
              <circle className="ajmote" r={2.4 + weight / 4}>
                <animateMotion dur={`${Math.max(2.2, 7 - (j.trips / busiest) * 4)}s`} repeatCount="indefinite" path={d} />
              </circle>
            </g>
          );
        })}

        {movers.map((a, i) => (
          <g key={a.id} className="ajnode" transform={`translate(0 ${yOf(i, movers.length)})`}>
            <rect x="0" y="-15" width={LEFT} height="30" rx="15" className="ajbox" />
            <text x="16" y="5" className="ajtext">{a.name}</text>
          </g>
        ))}

        {places.map((p, i) => {
          const trips = js.filter((j) => j.place === p.id).reduce((n, j) => n + j.trips, 0);
          return (
            <g key={p.id} className="ajnode place" transform={`translate(${RIGHT} ${yOf(i, places.length)})`}>
              <circle r="7" className="ajdot" />
              <text x="18" y="-1" className="ajtext">{p.name}</text>
              <text x="18" y="13" className="ajsub">{trips} {trips === 1 ? "visit" : "visits"}</text>
            </g>
          );
        })}
      </svg>

      <p className="ajsay" aria-live="polite">
        {hover
          ? `${hover.agentName} went to ${hover.placeName.toLowerCase()} ${hover.trips} ${hover.trips === 1 ? "time" : "times"} — ${hover.tools.join(", ")}.`
          : "Each curve is one agent's trips to one place. Agents never contact each other, so there are no lines between them."}
      </p>

      <ul className="ajlegend">
        {PLACES.map((p) => (
          <li key={p.id} className={places.some((v) => v.id === p.id) ? "" : "unused"}>
            <b>{p.name}</b> — {p.doing}
          </li>
        ))}
      </ul>
    </div>
  );
}
