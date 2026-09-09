import { useRef, useState } from 'react';
import { validateItemContent } from '@/engine/contentValidation';
import type { FieldDef, FieldValue, ItemType } from '@/engine/types';
import { parseClozeLines } from '@/engine/grading/cloze';

/** Raw input, parsed content, and attachment lifetimes belong to the same draft. */
export function useFieldDraft(
  type: ItemType | undefined,
  initial: Record<string, FieldValue> = {},
) {
  const [expectedType, setExpectedType] = useState(() =>
    type ? { rev: type.rev, generation: type.generation } : undefined,
  );
  const [values, setValues] = useState(initial);
  const [raw, setRaw] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (type?.fields ?? [])
        .filter((f) => f.kind === 'clozeSentences' && typeof initial[f.id] === 'string')
        .map((f) => [f.id, initial[f.id] as string]),
    ),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [generation, setGeneration] = useState(0);
  const version = useRef(0);
  const contentRevision = useRef(0);
  const reset = (next: Record<string, FieldValue> = {}, nextType = type) => {
    setExpectedType(nextType ? { rev: nextType.rev, generation: nextType.generation } : undefined);
    version.current++;
    contentRevision.current++;
    setGeneration(version.current);
    setValues(next);
    setRaw(
      Object.fromEntries(
        Object.entries(next).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
    );
    setErrors({});
    setPending({});
  };
  const fieldProps = (field: FieldDef) => {
    const expected = version.current;
    const current = () => version.current === expected;
    return {
      field,
      value: values[field.id],
      text: raw[field.id],
      onTextChange: (text: string) => {
        if (current()) {
          contentRevision.current++;
          setRaw((v) => ({ ...v, [field.id]: text }));
        }
      },
      onChange: (value: FieldValue) => {
        if (current()) {
          contentRevision.current++;
          setValues((v) => ({ ...v, [field.id]: value }));
          setErrors((v) => ({ ...v, [field.id]: '' }));
        }
      },
      onError: (message: string | null) => {
        if (current()) setErrors((v) => ({ ...v, [field.id]: message ?? '' }));
      },
      onPending: (value: boolean) => {
        if (current()) setPending((v) => ({ ...v, [field.id]: value }));
      },
    };
  };
  const busy = Object.values(pending).some(Boolean);
  const validate = (): Record<string, FieldValue> => {
    if (busy) throw new Error('Wait for the attachment to finish before saving.');
    const first = Object.values(errors).find(Boolean);
    if (first) throw new Error(first);
    if (!type) throw new Error('Choose an item type first.');
    if (
      !expectedType ||
      type.rev !== expectedType.rev ||
      type.generation !== expectedType.generation
    )
      throw new Error(
        'This item type changed while the draft was open. Copy your edits and reopen the form before saving.',
      );
    const candidate = { ...values };
    for (const field of type.fields) {
      if (field.kind !== 'clozeSentences' || raw[field.id] === undefined) continue;
      const parsed = parseClozeLines(raw[field.id]);
      if (parsed.error) throw new Error(`${field.name}: ${parsed.error}`);
      candidate[field.id] = parsed.sentences;
    }
    const result = validateItemContent(candidate, type);
    if (result.problems.length) {
      setErrors(Object.fromEntries(result.problems.map((p) => [p.fieldId, p.message])));
      throw new Error(result.problems.map((p) => p.message).join(' '));
    }
    return result.values;
  };
  return {
    values,
    errors,
    busy,
    generation,
    expectedType,
    revision: () => contentRevision.current,
    fieldProps,
    reset,
    validate,
  };
}
