/**
 * Chat streaming.
 *
 * The bundled llama-server exposes an OpenAI-compatible endpoint on loopback,
 * and the webview talks to it directly — which is why token streaming is real
 * server-sent events rather than something marshalled through IPC. The CSP in
 * `tauri.conf.json` permits exactly `http://127.0.0.1:*` for this.
 */
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
}

export interface StreamHandle {
  cancel: () => void;
}

export interface StreamCallbacks {
  onToken: (text: string) => void;
  onDone: (stats: { tokens: number; seconds: number }) => void;
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

  (async () => {
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Only the two fields the server expects; anything else is local bookkeeping.
        body: JSON.stringify({
          messages: messages.map((m) =>
            m.images && m.images.length
              ? {
                  role: m.role,
                  content: [
                    { type: "text", text: m.content },
                    ...m.images.map((url) => ({ type: "image_url", image_url: { url } })),
                  ],
                }
              : { role: m.role, content: m.content },
          ),
          stream: true,
          cache_prompt: true,
          // Describing an image should give the same answer each time. Ordinary chat keeps the engine's sampling.
          ...(messages.some((m) => m.images && m.images.length) ? { temperature: 0 } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        cb.onError(`The inference runtime returned ${res.status}.`);
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
                choices?: { delta?: { content?: string } }[];
              };
              const piece = json.choices?.[0]?.delta?.content;
              if (piece) {
                tokens += 1;
                cb.onToken(piece);
              }
            } catch {
              // A partial frame can arrive mid-chunk; the next read completes it.
            }
          }
        }
      }
      cb.onDone({ tokens, seconds: (performance.now() - started) / 1000 });
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        cb.onDone({ tokens, seconds: (performance.now() - started) / 1000 });
        return;
      }
      cb.onError(e instanceof Error ? e.message : String(e));
    }
  })();

  return { cancel: () => controller.abort() };
}
