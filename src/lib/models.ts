/**
 * Local model metadata and the derived-metric maths the selector's preview card
 * animates. This mirrors the shape of the dqnamo "Advanced Model Selector":
 * four metrics, and inline configuration that moves them live.
 *
 * The adaptation for Forge: the fourth metric is MEMORY COST rather than price,
 * because on your own hardware memory is what you actually spend.
 */
import type { Quant } from "./ipc";

export type Effort = "Off" | "Low" | "High";
export type Place = "Local" | "Cluster";

export interface ModelConfiguration {
  quant: Quant;
  effort: Effort;
  place: Place;
}

export const DEFAULT_CONFIGURATION: ModelConfiguration = {
  quant: "q4km",
  effort: "Off",
  place: "Local",
};

export const QUANT_LABEL: Record<Quant, string> = {
  q4km: "Q4_K_M",
  q5km: "Q5_K_M",
  q6k: "Q6_K",
  q80: "Q8_0",
  f16: "F16",
};

/** Size multiplier, intelligence delta and speed multiplier per quantization. */
export const QUANT_EFFECT: Record<Quant, { size: number; iq: number; speed: number }> = {
  q4km: { size: 1.0, iq: 0, speed: 1.0 },
  q5km: { size: 1.22, iq: 3, speed: 0.88 },
  q6k: { size: 1.42, iq: 4, speed: 0.78 },
  q80: { size: 1.9, iq: 5, speed: 0.65 },
  f16: { size: 3.6, iq: 6, speed: 0.38 },
};

export const EFFORT_EFFECT: Record<Effort, { iq: number; speed: number }> = {
  Off: { iq: 0, speed: 1.0 },
  Low: { iq: 4, speed: 0.85 },
  High: { iq: 9, speed: 0.55 },
};

/**
 * Splitting a model costs speed. The figure is a placeholder until the cluster
 * reports a measured one — `LocalModel.clusterSpeedFactor` overrides it.
 */
export const DEFAULT_CLUSTER_SPEED_FACTOR = 0.62;

export interface LocalModel {
  value: string;
  name: string;
  family: string;
  mark: string;
  params: string;
  /** 0-100 capability score from published benchmarks. */
  iq: number;
  /** Measured tokens/sec on THIS machine at q4km. Zero means unmeasured. */
  tps: number;
  context: number;
  /** Weight bytes at q4km. */
  bytes: number;
  tag?: { kind: "code" | "vis"; label: string };
  clusterSpeedFactor?: number;
}

export interface DerivedMetrics {
  iq: number;
  tps: number | null;
  bytes: number;
  context: number;
  bars: { iq: number; speed: number; context: number; cost: number };
}

/** The maths the inline configuration moves. Pure, so it is unit-testable. */
export function derive(m: LocalModel, c: ModelConfiguration): DerivedMetrics {
  const q = QUANT_EFFECT[c.quant];
  const e = EFFORT_EFFECT[c.effort];
  const placeFactor =
    c.place === "Cluster" ? (m.clusterSpeedFactor ?? DEFAULT_CLUSTER_SPEED_FACTOR) : 1;

  const iq = Math.min(100, m.iq + q.iq + e.iq);
  const tps = m.tps > 0 ? m.tps * q.speed * e.speed * placeFactor : null;
  const bytes = m.bytes * q.size;

  return {
    iq,
    tps,
    bytes,
    context: m.context,
    bars: {
      iq,
      speed: tps === null ? 0 : Math.min(100, (tps / 70) * 100),
      context: Math.min(100, (Math.log2(m.context / 8192) / 5) * 100),
      cost: Math.min(100, (bytes / (150 * 1024 ** 3)) * 100),
    },
  };
}

export function isCustom(c: ModelConfiguration): boolean {
  return (
    c.quant !== DEFAULT_CONFIGURATION.quant ||
    c.effort !== DEFAULT_CONFIGURATION.effort ||
    c.place !== DEFAULT_CONFIGURATION.place
  );
}

export function configBadge(c: ModelConfiguration): string {
  const parts = [QUANT_LABEL[c.quant].split("_")[0] ?? ""];
  if (c.effort !== "Off") parts.push(c.effort);
  if (c.place === "Cluster") parts.push("Cluster");
  return parts.join(" · ");
}

export function fmtContext(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)}K` : `${n}`;
}

export type Fit = "local" | "tight" | "cluster";

/** Does this configuration fit on one machine, given its usable budget? */
export function fitFor(
  bytes: number,
  usableBytes: number,
  place: Place,
): { fit: Fit; label: string } {
  // A budget of 0 means hardware detection has not answered yet. Say so rather
  // than claiming a fit we cannot verify.
  if (usableBytes <= 0) return { fit: "tight", label: "Checking hardware…" };
  if (place === "Cluster") return { fit: "cluster", label: "Cluster · split" };
  if (bytes > usableBytes) return { fit: "cluster", label: "Cluster only" };
  if (bytes > usableBytes * 0.72) return { fit: "tight", label: "Tight fit" };
  return { fit: "local", label: "Fits locally" };
}
