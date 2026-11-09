/**
 * Which Hugging Face organisation publishes each model's original weights.
 *
 * Catalogue entries point at quantisation uploads, which belong to one uploader, so the
 * repository owner is the wrong logo for every model. The logo shown is the developer's own
 * organisation, and only where that mapping is known. Unknown developers get the built-in mark.
 */
export const PUBLISHER_ORG: Record<string, string> = {
  "Alibaba Qwen": "Qwen",
  Meta: "meta-llama",
  "Google DeepMind": "google",
  DeepSeek: "deepseek-ai",
  "Mistral AI": "mistralai",
  Microsoft: "microsoft",
  IBM: "ibm-granite",
  "Hugging Face": "HuggingFaceTB",
};

/** The organisation to fetch a logo for, or "" when none is known. */
export function publisherFor(developer: string | undefined | null): string {
  if (!developer) return "";
  return PUBLISHER_ORG[developer] ?? "";
}
