/**
 * Auto model selection.
 *
 * The rule is simple and stated plainly in the UI: pick the installed model
 * whose declared strengths match the request and that fits in memory. It never
 * downloads anything and never leaves the machine, so the worst case is that
 * it picks the same model you would have picked by hand.
 */
import type { InstalledEntry } from "./library";

export type Intent = "code" | "web" | "reasoning" | "long" | "general";

const WEB = /\b(website|web ?page|landing page|html|css|tailwind|dashboard|ui mock|mock ?up|front ?end)\b/i;
const CODE = /\b(code|function|script|bug|refactor|typescript|javascript|python|rust|sql|regex|api|compile|stack trace)\b|```/i;
const REASON = /\b(prove|derive|solve|calculate|equation|logic puzzle|step by step|why does|optimi[sz]e|trade-?off)\b/i;

export function classify(prompt: string): Intent {
  if (WEB.test(prompt)) return "web";
  if (CODE.test(prompt)) return "code";
  if (REASON.test(prompt)) return "reasoning";
  if (prompt.length > 4000) return "long";
  return "general";
}

const WANTED: Record<Intent, string[]> = {
  code: ["code"],
  web: ["code"],
  reasoning: ["reasoning", "math"],
  long: ["long"],
  general: ["chat"],
};

export interface Choice {
  file_name: string;
  label: string;
  why: string;
}

export function choose(
  prompt: string,
  installed: InstalledEntry[],
  usableBytes: number,
  currentlyLoaded: string | null,
): Choice | null {
  if (!installed.length) return null;
  const intent = classify(prompt);
  const wanted = WANTED[intent];

  const scored = installed.map((m) => {
    const caps = m.record?.caps ?? [];
    const fits = usableBytes <= 0 || m.bytes <= usableBytes;
    let score = 0;
    if (caps.some((c) => wanted.includes(c))) score += 40;
    if (!fits) score -= 60;
    else if (m.bytes > usableBytes * 0.8) score -= 12;
    // Larger models generally answer better, so break ties by size within fit.
    score += Math.min(20, (m.record?.params_b ?? m.bytes / 1024 ** 3) * 2);
    // Reloading costs a minute or more; only switch for a real gain.
    if (m.file_name === currentlyLoaded) score += 10;
    return { m, score, fits, caps };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top) return null;

  const matched = top.caps.filter((c) => wanted.includes(c));
  const why =
    intent === "general"
      ? `general chat · ${top.m.label}`
      : matched.length
        ? `${intent} request · ${top.m.label} is tagged ${matched.join(", ")}`
        : `${intent} request · ${top.m.label} is the best fit installed`;

  return { file_name: top.m.file_name, label: top.m.label, why };
}
