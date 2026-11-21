/**
 * Where an agent goes when it works.
 *
 * An agent is not interesting as a box with a number in it. What is worth
 * seeing is where it went: out to the web to look something up, into the
 * library to read what is already here, to the publisher to put words into a
 * file or an email. Those are the three places, and they are not invented for
 * the picture — each one is a group of the tools agents actually have.
 *
 * Nothing is drawn that did not happen. A line to the web exists only because
 * that agent ran a search or opened a page, and its weight is the number of
 * times it did. There are no lines between agents, because agents do not
 * contact each other.
 */

export interface Place {
  id: string;
  name: string;
  /** What the agent is doing when it goes there, in plain words. */
  doing: string;
  tools: string[];
}

export const PLACES: Place[] = [
  {
    id: "web",
    name: "The web",
    doing: "searching and reading pages",
    tools: ["web_search", "read_page"],
  },
  {
    id: "library",
    name: "The library",
    doing: "reading your files, notes and what it has been told to remember",
    tools: ["knowledge", "read_files", "write_memory"],
  },
  {
    id: "publisher",
    name: "The publisher",
    doing: "writing documents and drafting mail",
    tools: ["write_file", "draft_email", "send_email"],
  },
  {
    id: "desk",
    name: "The desk",
    doing: "reading mail and setting reminders",
    tools: ["read_email", "create_reminder"],
  },
];

const PLACE_OF = new Map<string, string>();
for (const p of PLACES) for (const t of p.tools) PLACE_OF.set(t, p.id);

/** Which place a tool belongs to, or "" for one that belongs to none. */
export const placeOf = (tool: string): string => PLACE_OF.get(tool) ?? "";

export interface Journey {
  agent: string;
  agentName: string;
  place: string;
  placeName: string;
  /** How many times this agent used a tool in that place. */
  trips: number;
  /** The tools it used there, most used first. */
  tools: string[];
}

export interface AgentLike {
  id: string;
  name: string;
  used?: Record<string, number>;
}

/**
 * The journeys to draw, heaviest first.
 *
 * An agent that has never run produces nothing: a line with no trips behind it
 * would be a claim about work that was never done.
 */
export function journeys(agents: AgentLike[]): Journey[] {
  const out: Journey[] = [];
  for (const a of agents) {
    const perPlace = new Map<string, { trips: number; tools: Map<string, number> }>();
    for (const [tool, nRaw] of Object.entries(a.used || {})) {
      const n = Number(nRaw) || 0;
      if (n <= 0) continue;
      const id = placeOf(tool);
      if (!id) continue;
      const row = perPlace.get(id) || { trips: 0, tools: new Map() };
      row.trips += n;
      row.tools.set(tool, (row.tools.get(tool) || 0) + n);
      perPlace.set(id, row);
    }
    for (const [id, row] of perPlace) {
      const place = PLACES.find((p) => p.id === id)!;
      out.push({
        agent: a.id,
        agentName: a.name,
        place: id,
        placeName: place.name,
        trips: row.trips,
        tools: [...row.tools.entries()].sort((x, y) => y[1] - x[1]).map(([t]) => t),
      });
    }
  }
  return out.sort((x, y) => y.trips - x.trips);
}

/** The places that anything actually went to, in the order they are listed. */
export function placesVisited(js: Journey[]): Place[] {
  const seen = new Set(js.map((j) => j.place));
  return PLACES.filter((p) => seen.has(p.id));
}
