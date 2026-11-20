import { useEffect, useState } from 'react';

interface Props {
  value: number;
  onChange: (v: number) => void;
  label?: string;
  unit?: string;
  title?: string;
}

/** Text-backed number input so partial entries like "0." or "-" don't fight the controlled value. */
export function NumField({ value, onChange, label, unit, title }: Props) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (parseFloat(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
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
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
  if (!label) return input;
  return (
    <label className="field">
      <span>
        {label}
        {unit ? <em> [{unit}]</em> : null}
      </span>
      {input}
    </label>
  );
}
