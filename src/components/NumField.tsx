import { useEffect, useState } from 'react';
import { useUnits, type Quantity } from '../units';

interface Props {
  /** Canonical value (see units.ts). Displayed and edited in the selected unit system when `q` is given. */
  value: number;
  onChange: (v: number) => void;
  label?: string;
  /** Physical quantity: enables unit conversion and the unit label. */
  q?: Quantity;
  /** Fixed unit text, for quantities without a unit system (e.g. '%'). Ignored when `q` is set. */
  unit?: string;
  title?: string;
}

/** Text-backed number input so partial entries like "0." or "-" don't fight the controlled value. */
export function NumField({ value, onChange, label, q, unit, title }: Props) {
  const units = useUnits();
  const show = (v: number) => String(+(q ? units.to(q, v) : v).toPrecision(7));
  const [text, setText] = useState(() => show(value));

  useEffect(() => {
    const n = parseFloat(text);
    const canonical = Number.isFinite(n) ? (q ? units.from(q, n) : n) : NaN;
    // re-sync unless the text already means this value (typing in progress) in the current units
    if (!(Math.abs(canonical - value) <= 1e-9 * Math.max(1, Math.abs(value)))) setText(show(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, units.system]);

  const input = (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      title={title}
      aria-label={label}
      onChange={(e) => {
        setText(e.target.value);
        const n = parseFloat(e.target.value);
        if (Number.isFinite(n)) onChange(q ? units.from(q, n) : n);
      }}
    />
  );
  if (!label) return input;
  const u = q ? units.u(q) : unit;
  return (
    <label className="field">
      <span>
        {label}
        {u ? <em> [{u}]</em> : null}
      </span>
      {input}
    </label>
  );
}
