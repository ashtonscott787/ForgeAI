/**
 * The only place the frontend talks to the Rust core.
 *
 * Every type mirrors a `serde` type in the shell or in `forge-core`. If the two
 * drift, the build breaks here rather than at runtime.
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

/** Electron exposes `window.forge` from its preload; Tauri exposes its own IPC. */
type Bridge = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  on: (event: string, cb: (payload: unknown) => void) => () => void;
  pathForFile?: (file: File) => string;
};
const bridge: Bridge | undefined =
  typeof window !== "undefined" ? (window as unknown as { forge?: Bridge }).forge : undefined;

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (bridge) return bridge.invoke(cmd, args) as Promise<T>;
  return tauriInvoke<T>(cmd, args);
}
function listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<() => void> {
  if (bridge) return Promise.resolve(bridge.on(event, (p) => cb({ payload: p as T })));
  return tauriListen<T>(event, cb);
}

export type Backend = "metal" | "cuda" | "vulkan" | "cpu";
export type Trust = "selfhost" | "approved" | "pending";
export type Quant = "q4km" | "q5km" | "q6k" | "q80" | "f16";

export interface MachineCapability {
  schema: number;
  id: number;
  name: string;
  os: string;
  backend: Backend;
  trust: Trust;
  ram_bytes: number;
  vram_bytes: number;
  unified_memory: boolean;
  usable_model_bytes: number;
  runtimes: string[];
  links: { peer_id: number; mbit_s: number; rtt_ms: number }[];
  load: number;
  online: boolean;
}

export type Capability = "chat" | "code" | "reasoning" | "math" | "fast" | "long" | "multilingual" | "vision";

/** A catalogue row names a repository; the file itself is resolved on demand. */
export interface CatalogueEntry {
  id: string;
  name: string;
  family: string;
  developer: string;
  params_b: number;
  layers: number;
  max_context: number;
  license: string;
  caps: Capability[];
  repo: string;
  quants: string[];
  vision: boolean;
  /** Estimated weight size per quantization. Replaced by the real figure once resolved. */
  est_bytes: Record<string, number>;
  /** Zero means Forge has not measured it. Show "unmeasured", never a guess. */
  reference_tok_s: number;
  note?: string;
}

export interface Catalogue { schema: number; generated_at: string; models: CatalogueEntry[] }

/** What the Hugging Face repository actually holds, read at download time. */
export interface Resolved {
  repo: string;
  quant: string;
  matched_requested_quant: boolean;
  file_name: string;
  url: string;
  bytes: number;
  sha256: string;
  available_quants: string[];
}

export interface HubHit {
  repo: string;
  author: string;
  downloads: number;
  likes: number;
  updated: string;
  license: string;
  tags: string[];
}

export interface RepoFile {
  path: string;
  file_name: string;
  bytes: number;
  sha256: string;
  quant: string;
  split: boolean;
  url: string;
}

export type HubSort = "downloads" | "likes" | "lastModified" | "trendingScore";

export interface Health {
  runtime_available: boolean;
  runtime_id: string;
  models_dir: string;
  app_version: string;
}

export interface Settings {
  theme: "light" | "dark" | "system";
  context_size: number;
  gpu_layers: number;
  threads: number | null;
  selected_model: string | null;
  experimental_cluster: boolean;
  run_mode?: "gpu" | "cpu" | "split";
  split_layers?: number;
  load_into_memory?: boolean;
  memory_budget_bytes?: number | null;
  update_check?: boolean;
  update_download?: boolean;
  update_install?: boolean;
  update_channel?: "stable" | "beta";
  last_update_check?: number;
  skipped_version?: string | null;
}

export interface EngineStatus {
  running: boolean;
  port: number;
  model_file: string | null;
  base_url: string;
}

export interface InstalledModel { file_name: string; bytes: number }

export interface LinkReadiness {
  mesh_interface_detected: boolean;
  mesh_address: string | null;
  distributed_inference_enabled: boolean;
  explanation: string;
}

export interface Attachment {
  name: string;
  path: string;
  bytes: number;
  ext: string;
  kind: "pdf" | "docx" | "pptx" | "xlsx" | "text" | "table" | "image" | "other";
  pages: number | null;
  text: string;
  preview?: string | null;
  readable: boolean;
  note: string;
}

export interface ContextReport {
  context: string;
  report: { name: string; trimmed: boolean; chars: number }[];
}

export interface UpdateInfo {
  available: boolean;
  current: string;
  version?: string;
  notes?: string;
  published_at?: string;
  html_url?: string;
  checked_at: number;
  asset: { name: string; url: string; bytes: number } | null;
  checksums_url: string | null;
  installable?: boolean;
  reason?: string;
}

export interface UpdateProgress { received: number; total: number }

export interface Reminder {
  id: string;
  text: string;
  at: number;
  repeat: { kind: "daily" | "weekly" | "weekdays" | "monthly"; day?: number } | null;
  state: "pending" | "done";
  created: number;
  late?: boolean;
  last_fired?: number;
  history?: { fired: number; late: boolean }[];
}

export interface Memory {
  id: string;
  text: string;
  scope: "personal" | "project";
  project: string;
  pinned: boolean;
  expires: number | null;
  source: string;
  created: number;
}

export interface SecretStatus {
  available: boolean;
  providers: Record<string, { saved: number; hint: string; verified: boolean | null; verified_at: number | null }>;
}

export interface ResearchResult {
  provider: string;
  answer: string;
  sources: { url: string; title: string; date: string }[];
  fetched_at: number;
}

export interface DownloadProgress {
  model_id: string;
  received: number;
  total: number;
  bytes_per_sec: number;
  done: boolean;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  created: number;
  updated: number;
}
export interface SkillInput {
  name: string;
  description?: string;
  instructions: string;
  enabled?: boolean;
}
export interface Connector {
  id: string;
  name: string;
  description: string;
  base_url: string;
  auth_header: string;
  has_token: boolean;
  created: number;
}
export interface ConnectorInput {
  name: string;
  description?: string;
  base_url: string;
  auth_header?: string;
  /** Written to the OS keychain; never returned to the app. */
  token?: string;
}

export type ProviderId = "anthropic" | "openai";
export interface ProviderModel {
  id: string;
  label: string;
}
export interface ProviderStatus {
  provider: ProviderId;
  /** A key is saved in the OS keychain. Says nothing about whether it works. */
  saved: boolean;
  /** The last authenticated test passed at this time (ms). Null if never, or since a failure. */
  verified_at: number | null;
  /** Models the last successful test returned, plus any typed in by hand. */
  models: ProviderModel[];
  manual: string[];
  last_error: string | null;
  last_error_at: number | null;
}
export interface ProviderUsage {
  input: number | null;
  output: number | null;
}
export interface ProviderStreamResult {
  tokens: number;
  stopReason: string | null;
  usage: ProviderUsage;
  cancelled: boolean;
}

export const api = {
  health: () => invoke<Health>("health"),
  detectHardware: () => invoke<MachineCapability>("detect_hardware"),
  cpuLabel: () => invoke<string>("cpu_label"),
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (settings: Settings) => invoke<void>("set_settings", { settings }),
  catalogue: () => invoke<Catalogue>("catalogue"),
  installedModels: () => invoke<InstalledModel[]>("installed_models"),
  downloadModel: (modelId: string, url: string, fileName: string, sha256: string) =>
    invoke<string>("download_model", { modelId, url, fileName, sha256 }),
  deleteModel: (fileName: string) => invoke<void>("delete_model", { fileName }),
  startEngine: (modelFile: string) => invoke<EngineStatus>("start_engine", { modelFile }),
  /** Start the model only if it is not already the one running. */
  ensureEngine: (modelFile: string) => invoke<EngineStatus>("ensure_engine", { modelFile }),
  resolveArtifact: (repo: string, quant: string) =>
    invoke<Resolved>("resolve_artifact", { repo, quant }),
  searchHub: (opts: { query: string; sort?: HubSort; author?: string; limit?: number }) =>
    invoke<HubHit[]>("search_hub", opts),
  listRepoFiles: (repo: string) => invoke<{ repo: string; files: RepoFile[] }>("list_repo_files", { repo }),
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  previewInBrowser: (html: string, name: string) =>
    invoke<string>("preview_in_browser", { html, name }),
  saveTextFile: (suggestedName: string, content: string) =>
    invoke<string | null>("save_text_file", { suggestedName, content }),
  stopEngine: () => invoke<void>("stop_engine"),
  engineLog: () => invoke<string>("engine_log"),
  openEngineLog: () => invoke<void>("open_engine_log"),
  environment: () =>
    invoke<{
      translocated: boolean;
      app_path: string;
      in_applications: boolean;
      models_dir: string;
      free_disk_bytes: number;
      total_memory_bytes: number;
    }>("environment"),
  onEngineLoading: (cb: (p: { seconds: number; tail: string }) => void) =>
    listen<{ seconds: number; tail: string }>("engine://loading", (e) => cb(e.payload)),
  engineStatus: () => invoke<EngineStatus>("engine_status"),
  linkReadiness: () => invoke<LinkReadiness>("link_readiness"),
  parseWhen: (text: string) =>
    invoke<{ at: number; repeat: Reminder["repeat"]; text: string } | { error: string }>("parse_when", { text }),
  remindersList: () => invoke<Reminder[]>("reminders_list"),
  reminderCreate: (text: string, when: string) => invoke<Reminder>("reminder_create", { text, when }),
  reminderUpdate: (patch: Partial<Reminder> & { id: string }) => invoke<Reminder>("reminder_update", patch),
  reminderDelete: (id: string) => invoke<void>("reminder_delete", { id }),
  reminderSnooze: (id: string, minutes: number) => invoke<Reminder>("reminder_snooze", { id, minutes }),
  onReminderFired: (cb: (p: { reminder: Reminder; late: boolean }) => void) =>
    listen<{ reminder: Reminder; late: boolean }>("reminder://fired", (e) => cb(e.payload)),

  skillsList: () => invoke<Skill[]>("skills_list"),
  skillAdd: (s: SkillInput) => invoke<Skill>("skills_add", { ...s }),
  skillUpdate: (s: Partial<SkillInput> & { id: string }) => invoke<Skill>("skills_update", { ...s }),
  skillDelete: (id: string) => invoke<void>("skills_delete", { id }),
  skillsForPrompt: () => invoke<{ name: string; instructions: string }[]>("skills_for_prompt"),
  skillsExport: () => invoke<string | null>("skills_export"),
  skillsImport: () => invoke<{ added: number } | null>("skills_import"),
  connectorsList: () => invoke<Connector[]>("connectors_list"),
  connectorAdd: (c: ConnectorInput) => invoke<Connector>("connectors_add", { ...c }),
  connectorUpdate: (c: Partial<ConnectorInput> & { id: string }) => invoke<Connector>("connectors_update", { ...c }),
  connectorDelete: (id: string) => invoke<void>("connectors_delete", { id }),
  connectorCall: (id: string, path: string, method: "GET" | "POST", body?: string) =>
    invoke<{ status: number; body: string; truncated: boolean }>("connectors_call", { id, path, method, body }),
  memoryList: () => invoke<Memory[]>("memory_list"),
  memoryAdd: (m: { text: string; scope?: string; project?: string; pinned?: boolean; expires?: number | null; source?: string }) =>
    invoke<Memory>("memory_add", m),
  memoryUpdate: (m: Partial<Memory> & { id: string }) => invoke<Memory>("memory_update", m),
  memoryDelete: (id: string) => invoke<void>("memory_delete", { id }),
  memoryForPrompt: (project?: string) => invoke<string[]>("memory_for_prompt", { project }),
  memoryExport: () => invoke<string | null>("memory_export"),
  memoryImport: (replace: boolean) => invoke<{ added: number; total: number } | null>("memory_import", { replace }),

  secretStatus: () => invoke<SecretStatus>("secret_status"),
  secretConnect: (provider: string, key: string) =>
    invoke<{ connected: boolean; detail: string }>("secret_connect", { provider, key }),
  secretClear: (provider: string) => invoke<void>("secret_clear", { provider }),

  research: (query: string, provider?: string) => invoke<ResearchResult>("research_run", { query, provider }),
  researchScrape: (url: string) => invoke<ResearchResult>("research_scrape", { url }),

  pickFiles: () => invoke<Attachment[]>("pick_files"),
  readFiles: (paths: string[]) => invoke<Attachment[]>("read_files", { paths }),
  buildContext: (files: { name: string; text: string }[], question: string, budget: number) =>
    invoke<ContextReport>("build_context", { files, question, budget }),
  checkUpdate: (channel: "stable" | "beta") => invoke<UpdateInfo>("check_update", { channel }),
  downloadUpdate: (info: UpdateInfo) => invoke<{ file: string; version: string }>("download_update", { info }),
  applyUpdate: (file: string) => invoke<{ restarting: boolean }>("apply_update", { file }),
  revealUpdate: (file: string) => invoke<{ revealed: boolean }>("reveal_update", { file }),
  publisherAvatar: (author: string) => invoke<{ avatar: string | null }>("publisher_avatar", { author }),
  onUpdateProgress: (cb: (p: UpdateProgress) => void) =>
    listen<UpdateProgress>("update://progress", (e) => cb(e.payload)),
  previewRegister: (html: string) => invoke<{ id: string; url: string }>("preview_register", { html }),
  previewForget: (id: string) => invoke<null>("preview_forget", { id }),
  providerStatus: () => invoke<ProviderStatus[]>("provider_status"),
  providerKeySave: (provider: ProviderId, key: string) => invoke<ProviderStatus[]>("provider_key_save", { provider, key }),
  providerTest: (provider: ProviderId) => invoke<ProviderStatus[]>("provider_test", { provider }),
  providerDisconnect: (provider: ProviderId) => invoke<ProviderStatus[]>("provider_disconnect", { provider }),
  providerRemove: (provider: ProviderId) => invoke<ProviderStatus[]>("provider_remove", { provider }),
  providerManualAdd: (provider: ProviderId, id: string) => invoke<ProviderStatus[]>("provider_manual_add", { provider, id }),
  providerManualRemove: (provider: ProviderId, id: string) => invoke<ProviderStatus[]>("provider_manual_remove", { provider, id }),
  /** Streams a cloud reply. Tokens arrive through onProviderToken; the promise resolves with usage at the end. */
  providerStream: (args: { requestId: string; provider: ProviderId; model: string; system?: string; messages: { role: "user" | "assistant"; content: string }[] }) =>
    invoke<ProviderStreamResult>("provider_stream", { ...args }),
  providerCancel: (requestId: string) => invoke<{ cancelled: boolean }>("provider_cancel", { requestId }),
  onProviderToken: (cb: (p: { requestId: string; text: string }) => void) =>
    listen<{ requestId: string; text: string }>("provider://token", (e) => cb(e.payload)),
  onDownloadProgress: (cb: (p: DownloadProgress) => void) =>
    listen<DownloadProgress>("download://progress", (e) => cb(e.payload)),
};

/** True when running in a plain browser (`pnpm dev`) rather than inside Tauri. */
export const inTauri =
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "forge" in window);

export const GB = 1024 ** 3;
export const fmtBytes = (b: number) => {
  if (b >= GB) return `${(b / GB).toFixed(1)} GB`;
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)} MB`;
  return `${Math.round(b / 1024)} KB`;
};
/** Drag-and-drop gives a File; the shell needs its path. Empty when unavailable. */
export const pathForFile = (file: File): string => bridge?.pathForFile?.(file) ?? "";

export const CAP_LABEL: Record<string, string> = {
  chat: "Chat",
  code: "Coding",
  reasoning: "Reasoning",
  math: "Maths",
  fast: "Fast",
  long: "Long context",
  multilingual: "Multilingual",
  vision: "Vision",
};
