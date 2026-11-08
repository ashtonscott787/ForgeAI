/**
 * What is installed on this machine, and what each installed file is.
 *
 * The models directory only holds `.gguf` files, so the catalogue facts that
 * matter later — capabilities, context length, which family it came from — are
 * recorded here when the download finishes. Anything found on disk without a
 * record still appears, just without those extras.
 */
import type { CatalogueEntry, Capability, InstalledModel } from "./ipc";

export interface LibraryRecord {
  file_name: string;
  model_id: string;
  name: string;
  family: string;
  developer: string;
  params_b: number;
  max_context: number;
  caps: Capability[];
  quant: string;
  bytes: number;
  added: number;
}

const KEY = "forge.library.v1";

export function readLibrary(): Record<string, LibraryRecord> {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? (v as Record<string, LibraryRecord>) : {};
  } catch {
    return {};
  }
}

export function recordInstall(rec: LibraryRecord) {
  const all = readLibrary();
  all[rec.file_name] = rec;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* non-fatal */
  }
}

export function forgetInstall(fileName: string) {
  const all = readLibrary();
  delete all[fileName];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* non-fatal */
  }
}

export function recordFor(entry: CatalogueEntry, fileName: string, quant: string, bytes: number): LibraryRecord {
  return {
    file_name: fileName,
    model_id: entry.id,
    name: entry.name,
    family: entry.family,
    developer: entry.developer,
    params_b: entry.params_b,
    max_context: entry.max_context,
    caps: entry.caps,
    quant,
    bytes,
    added: Date.now(),
  };
}

/** A file on disk with whatever we know about it; unknown files still list. */
export interface InstalledEntry extends InstalledModel {
  record?: LibraryRecord;
  label: string;
}

export function describeInstalled(files: InstalledModel[]): InstalledEntry[] {
  const lib = readLibrary();
  return files.map((f) => {
    const record = lib[f.file_name];
    return {
      ...f,
      record,
      label: record?.name ?? f.file_name.replace(/\.gguf$/i, "").replace(/[-_]/g, " "),
    };
  });
}
