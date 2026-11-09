/**
 * Cloud models as they appear in the one model selector.
 *
 * A cloud model's value is `cloud:<provider>:<model id>`. Only models on a
 * connection's own list (from its last successful test, or typed in by hand)
 * are offered, so the selector cannot name a model the account cannot use.
 */
import type { ProviderId, ProviderStatus } from "./ipc";
import type { LocalModel } from "./models";

export const CLOUD_PREFIX = "cloud:";
export const PROVIDER_LABEL: Record<ProviderId, string> = { anthropic: "Anthropic", openai: "OpenAI" };
export const PROVIDER_ORDER: ProviderId[] = ["anthropic", "openai"];

export function cloudValue(provider: ProviderId, model: string): string {
  return `${CLOUD_PREFIX}${provider}:${model}`;
}

/** Splits a cloud value at the first colon after the provider. Model IDs may contain colons. */
export function parseCloud(value: string): { provider: ProviderId; model: string } | null {
  if (!value.startsWith(CLOUD_PREFIX)) return null;
  const rest = value.slice(CLOUD_PREFIX.length);
  const i = rest.indexOf(":");
  if (i < 0) return null;
  const provider = rest.slice(0, i);
  if (provider !== "anthropic" && provider !== "openai") return null;
  return { provider, model: rest.slice(i + 1) };
}

/** Models a connection can actually use: its verified list plus manual IDs, without duplicates. */
export function usableModels(s: ProviderStatus): { id: string; label: string; manual: boolean }[] {
  const seen = new Set<string>();
  const out: { id: string; label: string; manual: boolean }[] = [];
  for (const m of s.models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({ id: m.id, label: m.label, manual: false });
  }
  for (const id of s.manual) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: id, manual: true });
  }
  return out;
}

/** Selector rows for every connected provider. Nothing is shown unless it was verified or typed in. */
export function cloudRows(statuses: ProviderStatus[]): LocalModel[] {
  const rows: LocalModel[] = [];
  for (const p of PROVIDER_ORDER) {
    const s = statuses.find((x) => x.provider === p);
    if (!s || !s.verified_at) continue;
    for (const m of usableModels(s)) {
      rows.push({
        value: cloudValue(p, m.id),
        name: m.label,
        family: `${PROVIDER_LABEL[p]} · cloud`,
        mark: p,
        params: "API",
        iq: 0,
        tps: 0,
        // The API does not report context length here, so none is claimed.
        context: 0,
        bytes: 0,
        tag: undefined,
      });
    }
  }
  return rows;
}

/** Connection state in plain words. Saved credentials and verified connections are different things. */
export function connectionLabel(s: ProviderStatus): { text: string; tone: "ok" | "warn" | "bad" | "idle" } {
  if (!s.saved) return { text: "No key saved", tone: "idle" };
  if (s.last_error && !s.verified_at) return { text: "Key saved · last test failed", tone: "bad" };
  if (!s.verified_at) return { text: "Key saved · not verified yet", tone: "warn" };
  return { text: `Connected · ${usableModels(s).length} model${usableModels(s).length === 1 ? "" : "s"}`, tone: "ok" };
}
