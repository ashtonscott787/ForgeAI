/**
 * The only place the frontend talks to the Rust core.
 *
 * Every type mirrors a `serde` type in the shell or in `forge-core`. If the two
 * drift, the build breaks here rather than at runtime.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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

export interface Artifact { quant: Quant; url: string; bytes: number; sha256: string }

export interface CatalogueEntry {
  id: string;
  name: string;
  family: string;
  params_b: number;
  layers: number;
  max_context: number;
  vision: boolean;
  /** Zero means Forge has not measured it. Show "unmeasured", never a guess. */
  reference_tok_s: number;
  artifacts: Artifact[];
  license: string;
}

export interface Catalogue { schema: number; generated_at: string; models: CatalogueEntry[] }

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

export interface DownloadProgress {
  model_id: string;
  received: number;
  total: number;
  bytes_per_sec: number;
  done: boolean;
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
  stopEngine: () => invoke<void>("stop_engine"),
  engineStatus: () => invoke<EngineStatus>("engine_status"),
  linkReadiness: () => invoke<LinkReadiness>("link_readiness"),
  onDownloadProgress: (cb: (p: DownloadProgress) => void) =>
    listen<DownloadProgress>("download://progress", (e) => cb(e.payload)),
};

/** True when running in a plain browser (`pnpm dev`) rather than inside Tauri. */
export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const GB = 1024 ** 3;
export const fmtBytes = (b: number) => {
  if (b >= GB) return `${(b / GB).toFixed(1)} GB`;
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)} MB`;
  return `${Math.round(b / 1024)} KB`;
};
export const fileNameFor = (entry: CatalogueEntry, a: Artifact) =>
  a.url.split("/").pop() ?? `${entry.id}.gguf`;
