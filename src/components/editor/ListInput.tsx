import { useEffect, useState } from 'react';
import { TextInput } from '@/components/ui';

/** "a, b, c" → ['a', 'b', 'c'] — the one parser every comma-separated box uses. */
export function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * A comma-separated list box that owns its raw text. Deriving the text from
 * the parsed array on every keystroke (`value.join(', ')`) eats the comma the
 * user just typed — "cat," parses to ['cat'] and renders back as "cat" — so a
 * second entry could never be typed, only pasted. The parsed list still
 * reaches the parent on every change; the text only re-syncs when the parent
 * hands back a list that differs from what is typed (a reset, a swap).
 */
export function ListInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  className?: string;
}) {
  const [text, setText] = useState(() => value.join(', '));
  useEffect(() => {
    if (!sameList(splitList(text), value)) setText(value.join(', '));
    // only an external change should overwrite what is being typed
  }, [value]);
  return (
    <TextInput
      value={text}
      placeholder={placeholder}
      className={className}
      onChange={(e) => {
        setText(e.target.value);
        onChange(splitList(e.target.value));
      }}
    />
  );
}
