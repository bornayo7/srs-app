import { useState } from 'react';
import { Button, Field, Modal, TextInput, Select } from '@/components/ui';
import { newId } from '@/engine/ids';
import { diffItemType, validateItemType } from '@/engine/typeDesign';
import type { CardTemplate, FieldDef, ItemType } from '@/engine/types';
import { deleteItemType, describeTypeImpact, saveItemTypeEdit } from '@/services/itemTypes';
import { now } from '@/services/clock';
import { useOperation } from '@/hooks/useOperation';
import { TemplateEditor } from './TemplateEditor';

/** Field kinds offered in the designer, with a one-liner each. */
const FIELD_KINDS: { value: FieldDef['kind']; label: string }[] = [
  { value: 'text', label: 'text — one line' },
  { value: 'richtext', label: 'rich text — mnemonic markup' },
  { value: 'list', label: 'list — comma-separated values' },
  { value: 'image', label: 'image — picture prompt' },
  { value: 'audio', label: 'audio — sound clip' },
  { value: 'clozeSentences', label: 'cloze sentences — ⟦blank⟧ examples' },
];

export function TypeDesignerModal({
  original,
  creating,
  itemCount,
  canDelete,
  onClose,
}: {
  original: ItemType;
  creating: boolean;
  itemCount: number;
  canDelete: boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ItemType>(() => structuredClone(original));
  const operation = useOperation();
  const { error, busy } = operation;

  const issues = validateItemType(draft);
  const diff = diffItemType(original, draft);
  const impact = describeTypeImpact(diff, itemCount);

  const setField = (id: string, patch: Partial<FieldDef>) =>
    setDraft({
      ...draft,
      fields: draft.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    });

  const moveField = (index: number, delta: number) => {
    const next = [...draft.fields];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setDraft({ ...draft, fields: next });
  };

  const setTemplate = (id: string, patch: Partial<CardTemplate>) =>
    setDraft({
      ...draft,
      templates: draft.templates.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });

  const save = () =>
    operation.run(async () => {
      await saveItemTypeEdit(draft, now(), { create: creating });
      onClose();
    });

  return (
    <Modal
      wide
      title={`Design type · ${original.name}`}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <Button
            variant="danger"
            disabled={busy || !canDelete}
            title={canDelete ? 'Delete this type' : 'A course needs at least one item type'}
            onClick={async () => {
              const withItems =
                itemCount > 0 &&
                confirm(
                  `"${original.name}" still has ${itemCount} item(s). Delete the type AND those items?`,
                );
              if (itemCount > 0 && !withItems) return;
              if (itemCount === 0 && !confirm(`Delete the type "${original.name}"?`)) return;
              await operation.run(async () => {
                await deleteItemType(original.id, now(), { withItems });
                onClose();
              });
            }}
          >
            Delete type
          </Button>
          <div className="grow" />
          {error && (
            <span role="alert" className="mr-2 text-xs text-rose-300">
              {error}
            </span>
          )}
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || issues.length > 0}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save type'}
          </Button>
        </>
      }
    >
      <fieldset disabled={busy} className="min-w-0 space-y-5">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Name">
            <TextInput
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="max-w-52"
            />
          </Field>
          <Field label="Icon">
            <TextInput
              value={draft.icon}
              maxLength={4}
              onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
              className="max-w-20 text-center"
            />
          </Field>
          <Field label="Colour">
            <input
              type="color"
              value={draft.color}
              onChange={(e) => setDraft({ ...draft, color: e.target.value })}
              className="h-9 w-16 cursor-pointer rounded border border-slate-700 bg-slate-900"
            />
          </Field>
          <div
            className="ml-auto flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold text-white/95"
            style={{ backgroundColor: draft.color }}
          >
            {draft.icon} {draft.name || 'Unnamed'}
          </div>
        </div>

        <section>
          <h3 className="mb-2 text-sm font-semibold text-slate-200">Fields</h3>
          <div className="space-y-2">
            {draft.fields.map((f, i) => (
              <div key={f.id} className="flex flex-wrap items-center gap-2">
                <TextInput
                  aria-label={`Field ${i + 1} name`}
                  value={f.name}
                  onChange={(e) => setField(f.id, { name: e.target.value })}
                  className="max-w-44"
                />
                <Select
                  aria-label={`Field ${i + 1} kind`}
                  value={f.kind}
                  onChange={(e) => setField(f.id, { kind: e.target.value as FieldDef['kind'] })}
                >
                  {FIELD_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="ghost"
                  aria-label={`Move ${f.name} up`}
                  disabled={i === 0}
                  onClick={() => moveField(i, -1)}
                >
                  ↑
                </Button>
                <Button
                  variant="ghost"
                  aria-label={`Move ${f.name} down`}
                  disabled={i === draft.fields.length - 1}
                  onClick={() => moveField(i, 1)}
                >
                  ↓
                </Button>
                <Button
                  variant="ghost"
                  title="Remove this field (its values are deleted on save)"
                  aria-label={`Remove ${f.name} field`}
                  onClick={() =>
                    setDraft({ ...draft, fields: draft.fields.filter((x) => x.id !== f.id) })
                  }
                >
                  ✕
                </Button>
              </div>
            ))}
          </div>
          <Button
            className="mt-2"
            onClick={() =>
              setDraft({
                ...draft,
                fields: [
                  ...draft.fields,
                  { id: newId(), name: `Field ${draft.fields.length + 1}`, kind: 'text' },
                ],
              })
            }
          >
            + Add field
          </Button>
          <p className="mt-1 text-[11px] text-slate-500">
            The first non-media field is what lists show as the item's name.
          </p>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold text-slate-200">Card templates</h3>
          <div className="space-y-3">
            {draft.templates.map((tpl) => (
              <TemplateEditor
                key={tpl.id}
                template={tpl}
                fields={draft.fields}
                onChange={(patch) => setTemplate(tpl.id, patch)}
                onRemove={() =>
                  setDraft({
                    ...draft,
                    templates: draft.templates.filter((t) => t.id !== tpl.id),
                  })
                }
              />
            ))}
          </div>
          <Button
            className="mt-2"
            onClick={() =>
              setDraft({
                ...draft,
                templates: [
                  ...draft.templates,
                  {
                    id: newId(),
                    name: `Card ${draft.templates.length + 1}`,
                    promptFieldIds: draft.fields[0] ? [draft.fields[0].id] : [],
                    answerFieldId: (draft.fields[1] ?? draft.fields[0])?.id ?? '',
                    hintFieldIds: [],
                    grading: { mode: 'typed', answerLang: 'latin', typoTolerance: true },
                  },
                ],
              })
            }
          >
            + Add template
          </Button>
        </section>

        {issues.length > 0 && (
          <div className="rounded-lg border border-rose-900/70 bg-rose-950/30 p-3">
            <div className="mb-1 text-xs font-semibold text-rose-200">Fix before saving</div>
            <ul className="list-inside list-disc text-xs text-rose-200/90">
              {issues.map((iss, i) => (
                <li key={i}>
                  <span className="text-rose-300/70">{iss.path}:</span> {iss.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {issues.length === 0 && impact.length > 0 && (
          <div className="rounded-lg border border-amber-900/70 bg-amber-950/25 p-3">
            <div className="mb-1 text-xs font-semibold text-amber-200">
              Saving changes {itemCount} existing item{itemCount === 1 ? '' : 's'}
            </div>
            <ul className="list-inside list-disc text-xs text-amber-100/90">
              {impact.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </fieldset>
    </Modal>
  );
}
