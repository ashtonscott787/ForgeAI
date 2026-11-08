/**
 * Assistant replies are plain text. This splits one into the pieces the chat
 * can render natively: prose, code, a runnable HTML page, an interactive form,
 * or an email with separately copyable parts.
 *
 * Parsing is deliberately conservative. Anything it does not recognise stays a
 * code block or plain text, so a model that ignores the conventions still
 * produces a readable answer.
 */

export type UiField =
  | { id: string; label: string; kind: "checkbox"; options: string[]; value: string[] }
  | { id: string; label: string; kind: "radio" | "select"; options: string[]; value: string }
  | { id: string; label: string; kind: "slider"; min: number; max: number; step: number; value: number; unit?: string }
  | { id: string; label: string; kind: "text" | "date"; value: string; placeholder?: string };

export interface UiSpec {
  title?: string;
  note?: string;
  fields: UiField[];
  submit: string;
}

export interface EmailParts {
  to: string;
  cc?: string;
  subject: string;
  body: string;
}

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "code"; lang: string; code: string }
  | { kind: "html"; code: string }
  | { kind: "ui"; spec: UiSpec }
  | { kind: "email"; email: EmailParts };

const FENCE = /```([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;

export function parseSegments(content: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of content.matchAll(FENCE)) {
    const [whole, rawLang = "", code = ""] = m;
    const at = m.index ?? 0;
    if (at > last) pushText(out, content.slice(last, at));
    last = at + whole.length;
    const lang = rawLang.toLowerCase();
    if (lang === "forge-ui") {
      const spec = parseUi(code);
      out.push(spec ? { kind: "ui", spec } : { kind: "code", lang: "json", code: code.trimEnd() });
    } else if (lang === "html" && /<[a-z!]/i.test(code)) {
      out.push({ kind: "html", code: code.trimEnd() });
    } else {
      out.push({ kind: "code", lang: rawLang || "text", code: code.replace(/\n$/, "") });
    }
  }
  if (last < content.length) pushText(out, content.slice(last));
  return out;
}

/** Unterminated fences stream in token by token; show them as code as they grow. */
function pushText(out: Segment[], text: string) {
  const open = text.match(/```([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*)$/);
  if (open) {
    const before = text.slice(0, open.index ?? 0);
    if (before.trim()) addText(out, before);
    const lang = (open[1] || "text").toLowerCase();
    out.push(
      lang === "html"
        ? { kind: "html", code: open[2] ?? "" }
        : { kind: "code", lang: open[1] || "text", code: open[2] ?? "" },
    );
    return;
  }
  addText(out, text);
}

function addText(out: Segment[], text: string) {
  if (!text.trim()) return;
  const email = parseEmail(text);
  if (email) {
    if (email.before.trim()) out.push({ kind: "text", text: email.before.trim() });
    out.push({ kind: "email", email: email.parts });
    if (email.after.trim()) out.push({ kind: "text", text: email.after.trim() });
    return;
  }
  out.push({ kind: "text", text: text.trim() });
}

/** Recognises the "To: / Subject: / body" shape the app asks models to use. */
export function parseEmail(text: string): { before: string; after: string; parts: EmailParts } | null {
  const to = text.match(/^[ \t]*(?:To|Recipient|Recipients)[ \t]*:[ \t]*(.+)$/im);
  const subject = text.match(/^[ \t]*Subject[ \t]*:[ \t]*(.+)$/im);
  if (!to || !subject) return null;
  const first = Math.min(to.index ?? 0, subject.index ?? 0);
  const cc = text.match(/^[ \t]*Cc[ \t]*:[ \t]*(.+)$/im);
  const headerEnd = Math.max(
    (to.index ?? 0) + to[0].length,
    (subject.index ?? 0) + subject[0].length,
    cc ? (cc.index ?? 0) + cc[0].length : 0,
  );
  const rest = text.slice(headerEnd);
  // A trailing section that is clearly commentary rather than the letter.
  const cut = rest.search(/\n\s*(?:---|Let me know if|Would you like me to)/i);
  const body = (cut > 0 ? rest.slice(0, cut) : rest).replace(/^[\s\n]*(?:Body\s*:)?\s*/i, "").trimEnd();
  if (!body.trim()) return null;
  return {
    before: text.slice(0, first),
    after: cut > 0 ? rest.slice(cut) : "",
    parts: { to: to[1]!.trim(), cc: cc?.[1]?.trim(), subject: subject[1]!.trim(), body },
  };
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** Strict validation: a malformed spec renders as JSON rather than as a form. */
export function parseUi(raw: string): UiSpec | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const rawFields = Array.isArray(d.fields) ? d.fields : [];
  const fields: UiField[] = [];
  for (const [i, f0] of rawFields.entries()) {
    if (!f0 || typeof f0 !== "object") continue;
    const f = f0 as Record<string, unknown>;
    const id = str(f.id) || `f${i}`;
    const label = str(f.label) || id;
    const kind = str(f.kind);
    const options = Array.isArray(f.options) ? f.options.filter((o) => typeof o === "string").slice(0, 24) : [];
    if (kind === "checkbox") {
      if (!options.length) continue;
      const pre = Array.isArray(f.value) ? f.value.filter((v): v is string => typeof v === "string") : [];
      fields.push({ id, label, kind, options, value: pre.filter((v) => options.includes(v)) });
    } else if (kind === "radio" || kind === "select") {
      if (!options.length) continue;
      const pre = str(f.value);
      fields.push({ id, label, kind, options, value: options.includes(pre) ? pre : "" });
    } else if (kind === "slider") {
      const min = num(f.min, 0);
      const max = num(f.max, 100);
      if (max <= min) continue;
      const step = Math.max(num(f.step, 1), 0.0001);
      fields.push({ id, label, kind, min, max, step, value: Math.min(max, Math.max(min, num(f.value, min))), unit: str(f.unit) || undefined });
    } else if (kind === "text" || kind === "date") {
      fields.push({ id, label, kind, value: str(f.value), placeholder: str(f.placeholder) || undefined });
    }
    if (fields.length >= 12) break;
  }
  if (!fields.length) return null;
  return {
    title: str(d.title) || undefined,
    note: str(d.note) || undefined,
    fields,
    submit: str(d.submit) || "Continue",
  };
}

/** What gets sent back to the model when the form is submitted. */
export function summarise(spec: UiSpec, values: Record<string, unknown>): string {
  const lines = spec.fields.map((f) => {
    const v = values[f.id];
    if (f.kind === "checkbox") {
      const list = Array.isArray(v) ? v : [];
      return `${f.label}: ${list.length ? list.join(", ") : "none selected"}`;
    }
    if (f.kind === "slider") return `${f.label}: ${String(v ?? f.value)}${f.unit ?? ""}`;
    return `${f.label}: ${v === undefined || v === "" ? "not specified" : String(v)}`;
  });
  return `My choices:\n${lines.join("\n")}`;
}
