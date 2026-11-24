import { useEffect, useState } from "react";
import { api, fmtBytes, type MachineCapability, type Tier, type TierSettings } from "../lib/ipc";

/**
 * What this computer was judged to be, and the chance to disagree.
 *
 * Forge AI used to give every machine the same settings — 8192 tokens of
 * context, every layer on a graphics card it did not check for, and room
 * reserved for four conversations on a desktop app that holds one. An 8 GB
 * laptop and a workstation with a 24 GB card were treated identically, and
 * both were served badly by it.
 *
 * So the machine is measured and put in one of four tiers, and the panel
 * shows the measurements rather than only the verdict: somebody who thinks
 * the answer is wrong can see which number produced it. Choosing a tier by
 * hand overrides it, and what was detected is still shown beside the choice.
 */
export function TierPanel() {
  const [data, setData] = useState<{ tiers: TierSettings[]; machine: MachineCapability } | null>(null);
  const [busy, setBusy] = useState(false);
  const [speed, setSpeed] = useState<{ valid: boolean; describe: string } | null>(null);
  const [measuring, setMeasuring] = useState(false);

  const look = () => {
    void api.tiers().then(setData).catch(() => setData(null));
    void api.speedGet().then(setSpeed).catch(() => setSpeed(null));
  };
  useEffect(look, []);

  if (!data) return null;
  const m = data.machine;
  const detected = data.tiers.find((t) => t.id === m.tier_detected);

  return (
    <div className="panel tierpanel">
      <div className="panel-h"><span className="t">This computer</span></div>
      <div className="panel-b">
        <dl className="connect-facts">
          <div>
            <dt>Memory</dt>
            <dd className="num">{fmtBytes(m.ram_bytes)} — {fmtBytes(m.free_bytes)} free now</dd>
          </div>
          <div>
            <dt>Processor</dt>
            <dd className="num">
              {m.cores} cores{m.performance_cores !== m.cores ? `, ${m.performance_cores} of them fast` : ""}
            </dd>
          </div>
          <div>
            <dt>Graphics</dt>
            <dd>
              {m.gpu_kind === "none"
                ? "none found"
                : <>
                    {m.gpu_name || m.gpu_kind}
                    {m.unified_memory
                      ? " — shares the machine's memory"
                      : m.vram_known
                        ? ` — ${fmtBytes(m.vram_bytes)}`
                        : " — memory unknown"}
                  </>}
            </dd>
          </div>
          <div>
            <dt>Used by models</dt>
            <dd>{m.accelerated ? "yes" : "no, the processor does the work"}</dd>
          </div>
        </dl>

        {!m.accelerated && m.gpu_kind !== "none" && (
          <p className="sheet-warn">
            {m.gpu_name} is here, and this build cannot use it. The engine that ships with Forge AI
            runs on the processor on this platform, so the card sits idle.
          </p>
        )}

        <div className="speedrow">
          <span>
            <b>Speed</b>{" "}
            <span className="hint">
              {speed?.valid
                ? `${speed.describe}, measured on this computer`
                : "not measured on this computer yet"}
            </span>
          </span>
          <button
            className="ghostbtn small"
            disabled={measuring}
            onClick={() => {
              setMeasuring(true);
              void api.speedMeasure()
                .then((r) => { if (r.ok) look(); })
                .finally(() => setMeasuring(false));
            }}
          >
            {measuring ? "Measuring…" : speed?.valid ? "Measure again" : "Measure it"}
          </button>
        </div>
        <p className="hint">
          A model has to be running to measure. The figures in the model library are worked out from
          this one, by size, and are marked as estimates because that is what they are.
        </p>

        <h4 className="sub">How this machine is treated</h4>
        <div className="tiers">
          {data.tiers.map((t) => (
            <button
              key={t.id}
              className={`tier${t.id === m.tier ? " on" : ""}`}
              disabled={busy}
              aria-pressed={t.id === m.tier}
              onClick={() => {
                setBusy(true);
                // Pressing the one already chosen hands it back to the machine.
                const next: Tier | null = t.id === m.tier && m.tier_is_override ? null : (t.id as Tier);
                void api.setTier(next).then(() => look()).finally(() => setBusy(false));
              }}
            >
              <span className="tier-name">
                {t.label}
                {t.id === m.tier_detected && <span className="tier-detected">detected</span>}
              </span>
              <span className="tier-says">{t.says}</span>
              <span className="tier-nums num">
                up to {fmtBytes(t.max_model_bytes)} · {t.context.toLocaleString()} tokens
                {t.kv_type !== "f16" ? " · compressed cache" : ""}
              </span>
            </button>
          ))}
        </div>

        <p className="hint">
          {m.tier_is_override
            ? `Chosen by you. This machine measures as ${detected?.label ?? m.tier_detected} — press ${data.tiers.find((t) => t.id === m.tier)?.label} again to hand it back.`
            : "Chosen from the measurements above. Press another to override it."}
        </p>
      </div>
    </div>
  );
}
