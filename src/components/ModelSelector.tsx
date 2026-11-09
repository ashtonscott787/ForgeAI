/**
 * The model selector.
 *
 * Behaviour mirrors the dqnamo "Advanced Model Selector" it is modelled on:
 * a searchable combobox; moving the cursor opens a preview card with animated
 * metric bars; inline configuration inside that card adjusts the metrics live;
 * provider marks; per-model configuration badges; a scroll-faded list; and a
 * Send action in the composer beside it.
 *
 * It is a controlled component with the same prop shape, so the composer owns
 * `value`, `configurations` and `prompt`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mark, type MarkKind } from "./Marks";
import { Logo } from "./Logo";
import {
  DEFAULT_CONFIGURATION,
  EFFORT_EFFECT,
  QUANT_EFFECT,
  QUANT_LABEL,
  configBadge,
  derive,
  fitFor,
  fmtContext,
  isCustom,
  type Effort,
  type LocalModel,
  type ModelConfiguration,
  type Place,
} from "../lib/models";
import { fmtBytes, type Quant } from "../lib/ipc";

export interface ModelSelectorPromptProps {
  models: LocalModel[];
  value: string;
  configurations: Record<string, ModelConfiguration>;
  prompt: string;
  /** Bytes of weights this machine can hold, from `MachineCapability`. 0 = unknown. */
  usableBytes: number;
  /** True while a response is streaming; Send becomes Stop. */
  busy?: boolean;
  onStop?: () => void;
  onModelChange: (model: LocalModel) => void;
  onConfigurationChange: (modelValue: string, configuration: ModelConfiguration) => void;
  onPromptChange: (prompt: string) => void;
  onSubmit: (args: {
    model: LocalModel;
    configuration: ModelConfiguration;
    prompt: string;
  }) => void;
}

const QUANTS: Quant[] = ["q4km", "q5km", "q6k", "q80", "f16"];
const EFFORTS: Effort[] = ["Off", "Low", "High"];
const PLACES: Place[] = ["Local", "Cluster"];

export function ModelSelectorPrompt(props: ModelSelectorPromptProps) {
  const { models, value, configurations, prompt, usableBytes } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [fade, setFade] = useState({ top: false, bottom: false });

  const cfgOf = useCallback(
    (v: string): ModelConfiguration => ({ ...DEFAULT_CONFIGURATION, ...configurations[v] }),
    [configurations],
  );

  const selected = useMemo(
    () => models.find((m) => m.value === value) ?? models[0],
    [models, value],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.name.toLowerCase().includes(q) || m.family.toLowerCase().includes(q),
    );
  }, [models, query]);

  const cursored = filtered[Math.min(cursor, Math.max(0, filtered.length - 1))];
  const previewModel = cursored ?? selected;

  // close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(Math.max(0, models.findIndex((m) => m.value === value)));
      searchRef.current?.focus();
    }
  }, [open, models, value]);

  const recomputeFade = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setFade({
      top: el.scrollTop > 4,
      bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 4,
    });
  }, []);
  useEffect(recomputeFade, [recomputeFade, filtered, open]);

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) =>
        Math.max(0, Math.min(filtered.length - 1, c + (e.key === "ArrowDown" ? 1 : -1))),
      );
    } else if (e.key === "Enter" && cursored) {
      e.preventDefault();
      props.onModelChange(cursored);
      setOpen(false);
    }
  };

  const submit = () => {
    if (!selected || !prompt.trim() || props.busy) return;
    props.onSubmit({ model: selected, configuration: cfgOf(selected.value), prompt });
  };

  // With no model to choose, the composer stays visible but disabled, and says how to get one.
  if (!selected) {
    return (
      <div className="composer composer-empty">
        <textarea rows={1} disabled aria-describedby="no-model-hint" placeholder="Connect a cloud model or install a local one to start chatting." value={prompt} onChange={() => undefined} />
        <div className="hint" id="no-model-hint">Add a key under Settings → Cloud models, or install a model from Models.</div>
      </div>
    );
  }

  const selCfg = cfgOf(selected.value);

  // group rows the way the cluster thinks about them
  const groupOf = (m: LocalModel): string => {
    const d = derive(m, cfgOf(m.value));
    const f = fitFor(d.bytes, usableBytes, cfgOf(m.value).place);
    return f.fit === "cluster" ? "Needs more room" : f.fit === "tight" ? "Tight fit" : "Runs on this machine";
  };

  let lastGroup = "";

  return (
    <div className="composer">
      <textarea
        ref={taRef}
        rows={1}
        placeholder="Ask anything — nothing leaves your machines."
        value={prompt}
        onChange={(e) => {
          props.onPromptChange(e.target.value);
          const el = e.target;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />

      <div className="crow">
        <div className="pop-wrap" ref={popRef}>
          <button
            className="trigger"
            aria-expanded={open}
            aria-haspopup="listbox"
            onClick={() => setOpen((o) => !o)}
          >
            <span className="mark">
              {selected.author ? <Logo author={selected.author} name={selected.name} size={22} /> : <Mark kind={selected.mark as MarkKind} />}
            </span>
            <span>{selected.name}</span>
            {isCustom(selCfg) && <span className="cfgb">{configBadge(selCfg)}</span>}
            <svg className="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>

          <div className={`pop${open ? " open" : ""}`} role="listbox">
            <div className="pop-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
              <input
                ref={searchRef}
                placeholder="Search models…"
                autoComplete="off"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(0);
                }}
                onKeyDown={onSearchKey}
              />
              <kbd>↑↓</kbd>
            </div>

            <div className={`listwrap${fade.top ? " fade-t" : ""}${fade.bottom ? " fade-b" : ""}`}>
              <div className="pop-list" ref={listRef} onScroll={recomputeFade}>
                {filtered.length === 0 && <div className="pop-sec">No models match</div>}
                {filtered.map((m, i) => {
                  const c = cfgOf(m.value);
                  const d = derive(m, c);
                  const f = fitFor(d.bytes, usableBytes, c.place);
                  const g = groupOf(m);
                  const header = g !== lastGroup ? ((lastGroup = g), g) : null;
                  return (
                    <div key={m.value}>
                      {header && <div className="pop-sec">{header}</div>}
                      <button
                        role="option"
                        aria-selected={m.value === value}
                        className={`mrow${m.value === value ? " sel" : ""}${i === cursor ? " cursor" : ""}`}
                        onMouseEnter={() => setCursor(i)}
                        onClick={() => {
                          props.onModelChange(m);
                          setOpen(false);
                        }}
                      >
                        <span className="mico">
                          {m.author ? <Logo author={m.author} name={m.name} size={22} /> : <Mark kind={m.mark as MarkKind} />}
                        </span>
                        <span className="minfo">
                          <span className="mname">
                            {m.name}
                            {m.tag && <span className={`tag ${m.tag.kind}`}>{m.tag.label}</span>}
                            {isCustom(c) && <span className="cfgbadge">{configBadge(c)}</span>}
                          </span>
                          <span className="mmeta">
                            {m.params}
                            <i />
                            {fmtBytes(d.bytes)}
                            <i />
                            {fmtContext(m.context)} ctx
                          </span>
                        </span>
                        <span className="mright">
                          <span className={`fit ${f.fit}`}>
                            <span className="d" />
                            {f.label}
                          </span>
                          <span className="speed num">
                            {d.tps === null ? "unmeasured" : `~${d.tps.toFixed(d.tps < 10 ? 1 : 0)} tok/s`}
                          </span>
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="pop-foot">
              <span>{models.length} installed</span>
            </div>

            {previewModel && (
              <PreviewCard
                model={previewModel}
                configuration={cfgOf(previewModel.value)}
                usableBytes={usableBytes}
                onChange={(c) => props.onConfigurationChange(previewModel.value, c)}
              />
            )}
          </div>
        </div>

        {props.busy ? (
          <button className="send live stop" onClick={() => props.onStop?.()}>
            Stop
            <svg viewBox="0 0 24 24" fill="currentColor">
              <rect x="7" y="7" width="10" height="10" rx="2" />
            </svg>
          </button>
        ) : (
          <button className={`send${prompt.trim() ? " live" : ""}`} onClick={submit}>
            Send
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

/** Hover preview: four animated metric bars plus the inline configuration that moves them. */
function PreviewCard(p: {
  model: LocalModel;
  configuration: ModelConfiguration;
  usableBytes: number;
  onChange: (c: ModelConfiguration) => void;
}) {
  const d = derive(p.model, p.configuration);
  const overBudget = d.bytes > p.usableBytes;

  return (
    <div className="preview show">
      <div className="pv-h">
        <span className="mico">
          <Mark kind={p.model.mark as MarkKind} />
        </span>
        <span>
          <span className="t">{p.model.name}</span>
          <div className="s">
            {p.model.family} · {p.model.params} · {QUANT_LABEL[p.configuration.quant]}
          </div>
        </span>
      </div>

      <div className="bars">
        <Metric label="Intelligence" width={d.bars.iq} display={`${Math.round(d.iq)}`} />
        <Metric
          label="Speed"
          width={d.bars.speed}
          display={d.tps === null ? "unmeasured" : `${d.tps.toFixed(d.tps < 10 ? 1 : 0)} tok/s`}
        />
        <Metric label="Context" width={d.bars.context} display={fmtContext(d.context)} />
        <Metric label="Memory cost" width={d.bars.cost} display={fmtBytes(d.bytes)} dim />
      </div>

      <div className="pv-cfg">
        <Seg
          label="Quantization"
          options={QUANTS.map((q) => ({ value: q, label: QUANT_LABEL[q].split("_")[0] ?? q }))}
          current={p.configuration.quant}
          onPick={(q) => p.onChange({ ...p.configuration, quant: q })}
        />
        <Seg
          label="Reasoning"
          options={EFFORTS.map((e) => ({ value: e, label: e }))}
          current={p.configuration.effort}
          onPick={(e) => p.onChange({ ...p.configuration, effort: e })}
        />
        <Seg
          label="Run on"
          options={PLACES.map((x) => ({ value: x, label: x }))}
          current={p.configuration.place}
          onPick={(x) => p.onChange({ ...p.configuration, place: x })}
        />
      </div>

      <div className="pv-note">
        {p.configuration.place === "Cluster" ? (
          <>
            <b>Split across the cluster.</b> Capacity goes up, speed goes down. Worth it only
            because this model will not fit on one machine.
          </>
        ) : overBudget ? (
          <>
            <b>Will not fit on this machine.</b> Switch “Run on” to Cluster, or drop to a smaller
            quantization.
          </>
        ) : (
          <>
            <b>Fits on this machine alone.</b> Splitting it would be slower, so Forge keeps it
            local.
          </>
        )}
      </div>
    </div>
  );
}

function Metric(p: { label: string; width: number; display: string; dim?: boolean }) {
  return (
    <div className={`metric${p.dim ? " dim" : ""}`}>
      <div className="top">
        <span className="k">{p.label}</span>
        <span className="v">{p.display}</span>
      </div>
      <div className="track">
        <i style={{ width: `${Math.max(0, Math.min(100, p.width))}%` }} />
      </div>
    </div>
  );
}

function Seg<T extends string>(p: {
  label: string;
  options: { value: T; label: string }[];
  current: T;
  onPick: (v: T) => void;
}) {
  return (
    <div>
      <div className="cfg-l">{p.label}</div>
      <div className="seg">
        {p.options.map((o) => (
          <button
            key={o.value}
            className={o.value === p.current ? "on" : ""}
            onClick={(e) => {
              e.stopPropagation();
              p.onPick(o.value);
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// re-exported so the composer can seed state, matching the reference API
export { QUANT_EFFECT, EFFORT_EFFECT };
