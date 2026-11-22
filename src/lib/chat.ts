/**
 * Chat streaming.
 *
 * The bundled llama-server exposes an OpenAI-compatible endpoint on loopback,
 * and the webview talks to it directly — which is why token streaming is real
 * server-sent events rather than something marshalled through IPC. The CSP in
 * `tauri.conf.json` permits exactly `http://127.0.0.1:*` for this.
 */

/**
 * A new seed for every request.
 *
 * llama.cpp will happily reuse one, and with a cached prompt the same question
 * then comes back identical to the character. Drawn from the system's random
 * source and kept inside the 32-bit range the server accepts.
 */
export function freshSeed(random: () => number = Math.random): number {
  return Math.floor(random() * 0x7fffffff);
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /** Which model produced this turn, for the line under the reply. */
  model?: string;
  /** Measured timings for this turn. Absent means nothing was measured. */
  perf?: Perf;
  /** Provider-reported token usage for a cloud reply. Null fields were not reported, and are shown as such. */
  usage?: { input: number | null; output: number | null };
  /** Images attached to this turn, as data URLs. Only sent to vision models. */
  images?: string[];
  /** Files the user attached to this turn. */
  files?: { name: string; bytes: number; kind: string; readable: boolean }[];
  /** What the built-in browser did to produce this turn, shown as a collapsed summary. */
  browser?: BrowserActivity;
}

/** One thing the browser did. The label is what the person reads; nothing is inferred. */
export interface BrowserAction {
  kind: "opened" | "read" | "captured" | "searched";
  label: string;
  detail?: string;
}

/**
 * A record of browser work attached to a turn. Every entry describes something
 * that actually happened in the browser pane — never a plan or an intention.
 */
export interface BrowserActivity {
  actions: BrowserAction[];
  /** The page the actions ended on, shown as a small card. */
  page?: { title: string; url: string; shot?: string };
}

/** Every figure here is measured. Nothing is estimated or filled in. */
export interface Perf {
  total_ms: number;
  load_ms: number;
  first_token_ms: number;
  generate_ms: number;
  tokens: number;
  tok_s: number;
  model: string;
  machine: string;
  where: "local" | "cluster" | "cloud";
  context_chars?: number;
  /** Wall-clock time the answer finished, so a transcript read later still says when. */
  finished_at?: number;
}

export interface StreamHandle {
  cancel: () => void;
}

export interface StreamCallbacks {
  onToken: (text: string) => void;
  onDone: (stats: { tokens: number; answered: number; seconds: number }) => void;
  onError: (message: string) => void;
}

export function streamChat(
  baseUrl: string,
  messages: ChatMessage[],
  cb: StreamCallbacks,
): StreamHandle {
  const controller = new AbortController();
  const started = performance.now();
  let tokens = 0;
  /** True while the model's working is arriving, so the tag can be closed. */
  let inReasoning = false;
  /** Counted apart, so "thought but did not answer" can be told from "said nothing".  */
  let answered = 0;

  (async () => {
    try {
      const hasImages = messages.some((m) => m.images && m.images.length);
      const content = messages.map((m) =>
        m.images && m.images.length
          ? {
              role: m.role,
              content: [
                { type: "text", text: m.content },
                ...m.images.map((url) => ({ type: "image_url", image_url: { url } })),
              ],
            }
          : { role: m.role, content: m.content },
      );
      // The parts every engine understands, and the sampling, kept apart so
      // the second can be dropped if an engine refuses it.
      const core = { messages: content, stream: true, cache_prompt: true };
      // Describing an image should give the same answer each time, so that
      // path is pinned. Ordinary chat is sampled, with a fresh seed on every
      // request: asking the same question twice should not return the same
      // sentences word for word, because a person asking again is usually
      // asking for another go at it, not a replay.
      const sampling = hasImages
        ? { temperature: 0, seed: 0 }
        : { temperature: 0.8, top_p: 0.95, seed: freshSeed() };

      const send = (body: unknown) =>
        fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

      let res = await send({ ...core, ...sampling });
      if (res.status >= 400 && res.status < 500) {
        // Some builds of the engine refuse a sampling field they do not know,
        // and refuse the whole request with it. An answer without the extra
        // sampling is worth far more than a red message, so it is tried once
        // more with the fields every build accepts.
        const plain = await send(core);
        if (plain.ok) res = plain;
      }

      if (!res.ok) {
        // The engine explains itself in the body — "invalid sampling
        // parameter", "context size exceeded", the name of the field it did
        // not like. Reporting only the number threw that away and left
        // "returned 400" on screen, which tells nobody anything.
        let why = "";
        try {
          const text = await res.text();
          try {
            const j = JSON.parse(text);
            why = j?.error?.message || j?.message || j?.error || "";
          } catch {
            why = text;
          }
        } catch {
          why = "";
        }
        why = String(why).trim().slice(0, 400);
        cb.onError(
          why
            ? `The model could not answer: ${why} (HTTP ${res.status})`
            : `The model could not answer, and the engine gave no reason. (HTTP ${res.status})`,
        );
        return;
      }
      if (!res.body) {
        cb.onError("The inference runtime sent no response body.");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const json = JSON.parse(payload) as {
                choices?: { delta?: { content?: string; reasoning_content?: string } }[];
              };
              const delta = json.choices?.[0]?.delta;
              // A reasoning model's working does not arrive in `content`.
              // llama.cpp splits it into `reasoning_content`, and reading only
              // `content` meant a model that thought its way to an answer
              // looked like a model that said nothing at all: the engine log
              // showed hundreds of tokens generated while the app reported
              // "returned no text". It is wrapped in <think> so it is shown as
              // working rather than as the answer.
              const reasoning = delta?.reasoning_content;
              if (reasoning) {
                if (!inReasoning) { inReasoning = true; cb.onToken("<think>"); }
                tokens += 1;
                cb.onToken(reasoning);
              }
              const piece = delta?.content;
              if (piece) {
                if (inReasoning) { inReasoning = false; cb.onToken("</think>"); }
                tokens += 1;
                answered += 1;
                cb.onToken(piece);
              }
            } catch {
              // A partial frame can arrive mid-chunk; the next read completes it.
            }
          }
        }
      }
      // A reply that was all working and no answer still has a tag to close.
      if (inReasoning) { inReasoning = false; cb.onToken("</think>"); }
      cb.onDone({ tokens, answered, seconds: (performance.now() - started) / 1000 });
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        cb.onDone({ tokens, answered, seconds: (performance.now() - started) / 1000 });
        return;
      }
      // A bare browser error ("Failed to fetch", "network error") names
      // neither the stage nor the cause, and that is what was being shown.
      // The engine log, meanwhile, showed a clean run — two sides of one
      // moment, neither of which said what had gone wrong.
      const raw = e instanceof Error ? e.message : String(e);
      const where = tokens > 0 ? `after ${tokens} tokens had arrived` : "before the first token arrived";
      const guess = /fetch|network|ECONNREFUSED|load failed/i.test(raw)
        ? ` The engine at ${baseUrl} could not be reached — it may have stopped or restarted.`
        : "";
      cb.onError(`The answer stopped ${where}: ${raw}.${guess}`);
    }
  })();

  return { cancel: () => controller.abort() };
}
