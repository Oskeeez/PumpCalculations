import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { PRESSURE_UNITS, fromKPa, isPressureUnit, toKPa } from '../pressure';
import { useUnits } from '../units';

/** Density of the working fluid [kg/m3], for the "m head" and "ft head" units. */
export const DensityContext = createContext(998.2);

const KEY = 'pipe-network-pressure-unit';
let current = (() => {
  try {
    const v = localStorage.getItem(KEY);
    return v && (v === 'auto' || isPressureUnit(v)) ? v : 'auto';
  } catch {
    return 'auto';
  }
})();
const listeners = new Set<() => void>();
/** The pressure unit chosen in any field applies to all of them, and is remembered. 'auto' follows the SI / US switch. */
export function usePressureUnit(): [string, (u: string) => void] {
  const unit = useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => current);
  return [unit, (u) => {
    current = u;
    try {
      localStorage.setItem(KEY, u);
    } catch {
      /* ignore */
    }
    listeners.forEach((l) => l());
  }];
}

interface Props {
  /** Pressure in kPa (the unit the project stores). */
  value: number;
  onChange: (kPa: number) => void;
  label?: string;
  title?: string;
}

/**
 * A pressure input with a unit drop-down: kPa, Pa, bar, psi, metres of head and so on. Whatever unit is chosen, the project gets kPa.
 * Pressures are gauge unless the label says otherwise.
 */
export function PressureField({ value, onChange, label, title }: Props) {
  const U = useUnits();
  const rho = useContext(DensityContext);
  const [pref, setPref] = usePressureUnit();
  const unit = pref === 'auto' ? (U.system === 'si' ? 'kPa' : 'psi') : pref;
  const show = (kPa: number) => String(+fromKPa(unit, kPa, rho).toPrecision(6));
  const [text, setText] = useState(() => show(value));

  useEffect(() => {
    const n = parseFloat(text.replace(',', '.'));
    const kPa = Number.isFinite(n) ? toKPa(unit, n, rho) : Number.NaN;
    if (!(Math.abs(kPa - value) <= 1e-9 * Math.max(1, Math.abs(value)))) setText(show(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, unit, rho]);

  const input = (
    <div className="unit-row">
      <input
        type="text"
        inputMode="decimal"
        value={text}
        title={title}
        aria-label={label}
        onChange={(e) => {
          setText(e.target.value);
          const n = parseFloat(e.target.value.replace(',', '.'));
          if (Number.isFinite(n)) onChange(toKPa(unit, n, rho));
        }}
      />
      <select value={pref === 'auto' ? 'auto' : pref} aria-label={label ? `${label}: unit` : 'Pressure unit'} onChange={(e) => setPref(e.target.value)}>
        <option value="auto">{U.system === 'si' ? 'kPa (app)' : 'psi (app)'}</option>
        {PRESSURE_UNITS.map((u) => <option key={u.id} value={u.id} title={u.note}>{u.label}</option>)}
      </select>
    </div>
  );
  if (!label) return input;
  return (
    <label className="field">
      <span>{label}</span>
      {input}
    </label>
  );
}
