import type { ChangeEvent } from 'react';

interface FieldProps {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  multiline?: boolean;
  rows?: number;
  type?: 'text' | 'tel';
  inputMode?: 'text' | 'tel';
  maxLength?: number;
}

/**
 * Themed text field (single line or multiline). New shared control for the
 * keyword filter, ad description, cooperation message, etc.
 */
export function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  multiline = false,
  rows = 4,
  type = 'text',
  inputMode,
  maxLength,
}: FieldProps) {
  const handle = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => onChange(e.target.value);
  return (
    <label className="field">
      {label ? <span className="field__label">{label}</span> : null}
      {multiline ? (
        <textarea
          className="field__input field__input--area"
          value={value}
          onChange={handle}
          placeholder={placeholder}
          rows={rows}
          maxLength={maxLength}
        />
      ) : (
        <input
          className="field__input"
          value={value}
          onChange={handle}
          placeholder={placeholder}
          type={type}
          inputMode={inputMode}
          maxLength={maxLength}
        />
      )}
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}
