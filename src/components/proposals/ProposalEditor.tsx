import { useState } from 'react';
import { Button, Field, Modal, Select, TextArea, TextInput } from '@/components/ui';
import { FieldValueInput } from '@/components/editor/FieldValueInput';
import { useFieldDraft } from '@/components/editor/useFieldDraft';

import type { FieldValue, ItemType, Proposal, ProposalItem } from '@/engine/types';
import { updateProposalItem } from '@/services/proposals';
import { now } from '@/services/clock';
import { useOperation } from '@/hooks/useOperation';
function typeFor(p: Proposal, types: ItemType[]): ItemType | undefined {
  if (!p.item.type) return types.length === 1 ? types[0] : undefined;
  return types.find((t) => t.name.toLowerCase() === p.item.type!.toLowerCase());
}

/** Field values keyed by the type's canonical field names (packet fields are name-keyed, any case). */
function byCanonicalName(
  fields: Record<string, FieldValue>,
  type: ItemType | undefined,
): Record<string, FieldValue> {
  if (!type) return { ...fields };
  const lower = new Map(Object.entries(fields).map(([k, v]) => [k.toLowerCase(), v]));
  const out: Record<string, FieldValue> = {};
  for (const f of type.fields) {
    const v = lower.get(f.name.toLowerCase());
    if (v !== undefined) out[f.name] = v;
  }
  return out;
}

function synonymsByTemplate(
  syn: ProposalItem['synonyms'],
  type: ItemType | undefined,
): Record<string, string> {
  if (!syn || !type) return {};
  if (Array.isArray(syn))
    return type.templates[0] ? { [type.templates[0].name]: syn.join(', ') } : {};
  const out: Record<string, string> = {};
  for (const tpl of type.templates) {
    const entry = Object.entries(syn).find(([k]) => k.toLowerCase() === tpl.name.toLowerCase());
    if (entry) out[tpl.name] = entry[1].join(', ');
  }
  return out;
}

const splitList = (raw: string) =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Edit a proposal before accepting it — fields, alternates, mnemonic, prerequisite handles. */
export function ProposalEditor({
  p,
  types,
  onClose,
}: {
  p: Proposal;
  types: ItemType[];
  onClose: () => void;
}) {
  const initialType = typeFor(p, types) ?? types[0];
  const [typeId, setTypeId] = useState(initialType?.id ?? '');
  const type = types.find((t) => t.id === typeId) ?? initialType;
  const names = byCanonicalName(p.item.fields, initialType);
  const fields = useFieldDraft(
    type,
    Object.fromEntries(
      (initialType?.fields ?? [])
        .filter((f) => names[f.name] !== undefined)
        .map((f) => [f.id, names[f.name]]),
    ),
  );
  const [synonyms, setSynonyms] = useState<Record<string, string>>(() =>
    synonymsByTemplate(p.item.synonyms, initialType),
  );
  const [note, setNote] = useState(p.item.note ?? '');
  const [key, setKey] = useState(p.item.key ?? '');
  const [prereqs, setPrereqs] = useState((p.item.prereqs ?? []).join(', '));
  const operation = useOperation();
  const { error, busy } = operation;

  if (!type) return null;

  async function save() {
    if (!type) return;
    await operation.run(async () => {
      const parsed = fields.validate();
      const present = type.fields
        .map((f) => [f.name, parsed[f.id]] as const)
        .filter(([, v]) => (typeof v === 'string' ? v.trim().length > 0 : v.length > 0));
      const synRecord = Object.fromEntries(
        Object.entries(synonyms)
          .map(([tpl, raw]) => [tpl, splitList(raw)] as const)
          .filter(([, list]) => list.length > 0),
      );
      const prereqList = splitList(prereqs);
      const item: ProposalItem = {
        ...(p.item.blockList ? { blockList: p.item.blockList } : {}),
        ...(p.item.guidance ? { guidance: p.item.guidance } : {}),
        type: type.name,
        fields: Object.fromEntries(present),
        ...(key.trim() ? { key: key.trim() } : {}),
        ...(prereqList.length > 0 ? { prereqs: prereqList } : {}),
        ...(Object.keys(synRecord).length > 0 ? { synonyms: synRecord } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      };
      await updateProposalItem(p.id, item, now());
      onClose();
    });
  }

  return (
    <Modal
      title="Edit proposal"
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || fields.busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <fieldset disabled={busy} className="min-w-0 space-y-3">
        {types.length > 1 && (
          <Field label="Item type">
            <Select
              value={type.id}
              onChange={(e) => {
                const next = types.find((t) => t.id === e.target.value);
                setTypeId(e.target.value);
                const previous = Object.fromEntries(
                  type.fields.map((f) => [f.name, fields.values[f.id]]),
                );
                const mapped = byCanonicalName(previous, next);
                fields.reset(
                  Object.fromEntries(
                    (next?.fields ?? [])
                      .filter((f) => mapped[f.name] !== undefined)
                      .map((f) => [f.id, mapped[f.name]]),
                  ),
                  next,
                );
                setSynonyms({});
              }}
            >
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.icon} {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          {type.fields.map((f) => (
            <Field
              key={`${type.id}:${f.id}:${fields.generation}`}
              label={f.name}
              className={
                f.kind === 'clozeSentences' || f.kind === 'richtext' ? 'sm:col-span-2' : ''
              }
            >
              <FieldValueInput {...fields.fieldProps(f)} />
            </Field>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {type.templates.map((tpl) => (
            <Field key={tpl.id} label={`Also accept for “${tpl.name}” (comma-separated)`}>
              <TextInput
                value={synonyms[tpl.name] ?? ''}
                onChange={(e) => setSynonyms({ ...synonyms, [tpl.name]: e.target.value })}
              />
            </Field>
          ))}
        </div>
        <Field label="Note / mnemonic">
          <TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field
            label="Handle (so later items can build on this one)"
            hint="Letters, digits, dashes."
          >
            <TextInput value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <Field
            label="Builds on (handles, comma-separated)"
            hint="Stays locked until those items pass. Must already be accepted."
          >
            <TextInput value={prereqs} onChange={(e) => setPrereqs(e.target.value)} />
          </Field>
        </div>
        {error && (
          <p role="alert" className="text-sm text-rose-300">
            {error}
          </p>
        )}
      </fieldset>
    </Modal>
  );
}
