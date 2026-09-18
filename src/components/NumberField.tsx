import { useState } from "react";

export default function NumberField(props: {
  value: number | null;
  placeholder?: string;
  onCommit: (v: number | null) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  const { value, placeholder, onCommit, ...rest } = props;
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (value === null ? "" : String(+value.toFixed(2)));
  const commit = () => {
    if (text === null) return;
    setText(null);
    if (text.trim() === "") {
      if (value !== null) onCommit(null);
      return;
    }
    const v = parseFloat(text);
    if (!Number.isFinite(v)) return;
    if (value === null || v !== value) onCommit(v);
  };
  return (
    <input
      type="number"
      placeholder={placeholder}
      {...rest}
      value={shown}
      onFocus={(e) => setText(e.target.value)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setText(null);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
