import { useState } from "react";
import type { UiField, UiSpec } from "../lib/blocks";
import { summarise } from "../lib/blocks";

/**
 * An interactive block the model asked for. Values live here, are validated
 * against the spec that produced them, and are sent back as an ordinary chat
 * message on submit — so the model receives real choices, not a transcript of
 * a form it imagined.
 */
export function GenUI({
  spec,
  disabled,
  onSubmit,
}: {
  spec: UiSpec;
  disabled?: boolean;
  onSubmit: (text: string) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const f of spec.fields) init[f.id] = f.kind === "checkbox" ? [...f.value] : f.value;
    return init;
  });
  const [sent, setSent] = useState(false);

  const set = (id: string, v: unknown) => setValues((p) => ({ ...p, [id]: v }));

  return (
    <div className={`genui${sent ? " sent" : ""}`}>
      {spec.title && <div className="genui-title">{spec.title}</div>}
      {spec.note && <div className="genui-note">{spec.note}</div>}

      {spec.fields.map((f) => (
        <Field key={f.id} field={f} value={values[f.id]} disabled={sent || disabled} onChange={(v) => set(f.id, v)} />
      ))}

      <div className="genui-actions">
        <button
          className="primary"
          disabled={sent || disabled}
          onClick={() => {
            setSent(true);
            onSubmit(summarise(spec, values));
          }}
        >
          {sent ? "Sent" : spec.submit}
        </button>
        {!sent && (
          <button
            className="ghostbtn"
            onClick={() => {
              const init: Record<string, unknown> = {};
              for (const f of spec.fields) init[f.id] = f.kind === "checkbox" ? [] : f.kind === "slider" ? f.min : "";
              setValues(init);
            }}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

function Field({
  field,
  value,
  disabled,
  onChange,
}: {
  field: UiField;
  value: unknown;
  disabled?: boolean;
  onChange: (v: unknown) => void;
}) {
  if (field.kind === "checkbox") {
    const sel = Array.isArray(value) ? (value as string[]) : [];
    return (
      <fieldset className="gfield">
        <legend>{field.label}</legend>
        <div className="optgrid">
          {field.options.map((o) => {
            const on = sel.includes(o);
            return (
              <label key={o} className={`opt${on ? " on" : ""}`}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={disabled}
                  onChange={() => onChange(on ? sel.filter((x) => x !== o) : [...sel, o])}
                />
                <span>{o}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
    );
  }
  if (field.kind === "radio") {
    return (
      <fieldset className="gfield">
        <legend>{field.label}</legend>
        <div className="optgrid">
          {field.options.map((o) => (
            <label key={o} className={`opt${value === o ? " on" : ""}`}>
              <input
                type="radio"
                name={field.id}
                checked={value === o}
                disabled={disabled}
                onChange={() => onChange(o)}
              />
              <span>{o}</span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  if (field.kind === "select") {
    return (
      <label className="gfield">
        <span className="glabel">{field.label}</span>
        <select
          className="qsel wide"
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Choose…</option>
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (field.kind === "slider") {
    const v = typeof value === "number" ? value : field.min;
    return (
      <label className="gfield">
        <span className="glabel">
          {field.label} <b className="num">{v}{field.unit ?? ""}</b>
        </span>
        <input
          type="range"
          min={field.min}
          max={field.max}
          step={field.step}
          value={v}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </label>
    );
  }
  if (field.kind !== "text" && field.kind !== "date") return null;
  return (
    <label className="gfield">
      <span className="glabel">{field.label}</span>
      <input
        className="inp"
        type={field.kind === "date" ? "date" : "text"}
        placeholder={field.placeholder}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
