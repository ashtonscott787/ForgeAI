/**
 * Family marks.
 *
 * These are original geometric marks drawn for Forge AI, one per model family,
 * each with its own colour. They are deliberately NOT the model makers' logos:
 * a shipped application must not redistribute third-party brand marks it has no
 * licence to use. Each card still names the developer in text, which is what
 * actually tells you whose model it is.
 */
export type MarkKind =
  | "qwen"
  | "meta"
  | "google"
  | "deepseek"
  | "mistral"
  | "microsoft"
  | "ibm"
  | "hf"
  | "moonshot"
  | "zhipu"
  | "yi"
  | "cohere"
  | "nvidia"
  | "falcon"
  | "anthropic"
  | "openai"
  | "generic";

const PALETTE: Record<MarkKind, [string, string]> = {
  qwen: ["#7c6bf0", "#b06ae0"],
  meta: ["#3b82f6", "#22d3ee"],
  google: ["#ea4c4c", "#f5b400"],
  deepseek: ["#4f6bf6", "#8aa6ff"],
  mistral: ["#ff8a3d", "#ffc53d"],
  microsoft: ["#00a4ef", "#7cd4ff"],
  ibm: ["#1f70c1", "#6aa9e9"],
  hf: ["#ffcc4d", "#ff9a3d"],
  moonshot: ["#2f3bd6", "#6f7bff"],
  zhipu: ["#2563eb", "#60a5fa"],
  yi: ["#16a394", "#5fd6c6"],
  cohere: ["#d946a0", "#f0a3d6"],
  nvidia: ["#62b800", "#a5e65a"],
  falcon: ["#0ea5a5", "#7fd9d9"],
  // Neutral badge colours for cloud providers. Not the vendors' logos.
  anthropic: ["#c96442", "#e8a07c"],
  openai: ["#10a37f", "#6ee7c0"],
  generic: ["#8b8b94", "#c3c3cb"],
};

/** Maps a family or developer name onto one of the marks above. */
export function markFor(name: string): MarkKind {
  const n = name.toLowerCase();
  if (n.includes("qwen") || n.includes("alibaba")) return "qwen";
  if (n.includes("llama") || n.includes("meta")) return "meta";
  if (n.includes("gemma") || n.includes("google") || n.includes("deepmind")) return "google";
  if (n.includes("deepseek")) return "deepseek";
  if (n.includes("mistral") || n.includes("mixtral") || n.includes("magistral")) return "mistral";
  if (n.includes("phi") || n.includes("microsoft")) return "microsoft";
  if (n.includes("granite") || n.includes("ibm")) return "ibm";
  if (n.includes("smol") || n.includes("hugging")) return "hf";
  if (n.includes("kimi") || n.includes("moonshot")) return "moonshot";
  if (n.includes("glm") || n.includes("zhipu") || n.includes("chatglm")) return "zhipu";
  if (n.includes("yi-") || n.includes("01-ai")) return "yi";
  if (n.includes("command") || n.includes("cohere") || n.includes("aya")) return "cohere";
  if (n.includes("nemotron") || n.includes("nvidia")) return "nvidia";
  if (n.includes("falcon") || n.includes("tii")) return "falcon";
  if (n.includes("anthropic") || n.includes("claude")) return "anthropic";
  if (n.includes("openai") || n.includes("gpt")) return "openai";
  return "generic";
}

export function Mark({ kind, size = 26 }: { kind: MarkKind; size?: number }) {
  const [a, b] = PALETTE[kind] ?? PALETTE.generic;
  const id = `mk-${kind}`;
  return (
    <span className="mark" style={{ width: size, height: size }}>
      <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={a} />
            <stop offset="100%" stopColor={b} />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="32" height="32" rx="9" fill={`url(#${id})`} opacity="0.17" />
        <g stroke={`url(#${id})`} fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <Shape kind={kind} accent={`url(#${id})`} />
        </g>
      </svg>
    </span>
  );
}

function Shape({ kind, accent }: { kind: MarkKind; accent: string }) {
  switch (kind) {
    case "anthropic": // provider initial, drawn as text; not the vendor logo
      return <text x="16" y="21.5" textAnchor="middle" fontSize="15" fontWeight="700" fill={accent} stroke="none">A</text>;
    case "openai":
      return <text x="16" y="21.5" textAnchor="middle" fontSize="15" fontWeight="700" fill={accent} stroke="none">O</text>;
    case "qwen": // stacked hexagon
      return (
        <>
          <path d="M16 6.5l8 4.6v9.8l-8 4.6-8-4.6v-9.8z" />
          <path d="M16 12l3.8 2.2v4.4L16 20.8l-3.8-2.2v-4.4z" fill={accent} stroke="none" opacity="0.5" />
        </>
      );
    case "meta": // double arc
      return <path d="M6 20c0-6 2.6-9.5 5.6-9.5 3.8 0 4.4 11 8.8 11 2.6 0 5.6-3.5 5.6-9.5" />;
    case "google": // four-point spark
      return (
        <path
          d="M16 5c.9 5.6 4.5 9.2 11 10-6.5.8-10.1 4.4-11 10-.9-5.6-4.5-9.2-11-10 6.5-.8 10.1-4.4 11-10z"
          fill={accent}
          stroke="none"
        />
      );
    case "deepseek": // orbit
      return (
        <>
          <circle cx="16" cy="16" r="6.4" />
          <ellipse cx="16" cy="16" rx="11" ry="4.6" transform="rotate(-28 16 16)" opacity="0.65" />
        </>
      );
    case "mistral": // stepped bars
      return (
        <>
          <path d="M7 24V12h5v12" />
          <path d="M14.5 24V8h5v16" opacity="0.75" />
          <path d="M22 24v-8h3v8" opacity="0.5" />
        </>
      );
    case "microsoft": // quad tiles
      return (
        <g fill={accent} stroke="none">
          <rect x="7" y="7" width="8" height="8" rx="2" />
          <rect x="17" y="7" width="8" height="8" rx="2" opacity="0.55" />
          <rect x="7" y="17" width="8" height="8" rx="2" opacity="0.55" />
          <rect x="17" y="17" width="8" height="8" rx="2" opacity="0.8" />
        </g>
      );
    case "ibm": // rule stack
      return (
        <>
          <path d="M7 11h18M7 16h18M7 21h18" />
          <path d="M12 11v10M20 11v10" opacity="0.45" />
        </>
      );
    case "moonshot": // crescent
      return (
        <>
          <circle cx="16" cy="16" r="8.6" />
          <path d="M19.5 9.2a8.6 8.6 0 000 13.6" opacity="0.5" />
        </>
      );
    case "zhipu": // nested chevrons
      return (
        <>
          <path d="M8 12l8-5 8 5" />
          <path d="M8 17l8-5 8 5" opacity="0.7" />
          <path d="M8 22l8-5 8 5" opacity="0.45" />
        </>
      );
    case "yi": // vertical pair
      return (
        <>
          <path d="M11 8v16M21 8v16" />
          <path d="M11 16h10" opacity="0.5" />
        </>
      );
    case "cohere": // ring segments
      return (
        <>
          <path d="M22.6 9.4a9 9 0 11-12.7 12.7" />
          <circle cx="16" cy="16" r="3.2" fill={accent} stroke="none" opacity="0.6" />
        </>
      );
    case "nvidia": // eye
      return (
        <>
          <path d="M6 16c4-6 16-6 20 0-4 6-16 6-20 0z" />
          <circle cx="16" cy="16" r="2.6" fill={accent} stroke="none" opacity="0.7" />
        </>
      );
    case "falcon": // wing
      return (
        <>
          <path d="M7 21c6 1 12-3 18-11" />
          <path d="M9 25c5-1 10-5 13-11" opacity="0.5" />
        </>
      );
    case "hf": // facet
      return (
        <>
          <path d="M16 6l9 6v8l-9 6-9-6v-8z" />
          <path d="M7 12l9 6 9-6" opacity="0.5" />
        </>
      );
    default:
      return (
        <>
          <circle cx="16" cy="16" r="8.5" />
          <path d="M16 7.5v17" opacity="0.45" />
        </>
      );
  }
}
