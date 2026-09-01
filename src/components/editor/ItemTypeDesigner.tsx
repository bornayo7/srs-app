import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { Badge, Button, Field, Modal, Panel, Select, TextInput } from '@/components/ui';
import { newId } from '@/engine/ids';
import { diffItemType, validateItemType } from '@/engine/typeDesign';
import type { CardTemplate, Course, FieldDef, ItemType } from '@/engine/types';
import {
  createBlankItemType,
  deleteItemType,
  describeTypeImpact,
  saveItemTypeEdit,
} from '@/services/itemTypes';
import { now } from '@/services/clock';

/** Field kinds offered in the designer, with a one-liner each. */
const FIELD_KINDS: { value: FieldDef['kind']; label: string }[] = [
  { value: 'text', label: 'text — one line' },
  { value: 'richtext', label: 'rich text — mnemonic markup' },
  { value: 'list', label: 'list — comma-separated values' },
  { value: 'image', label: 'image — picture prompt' },
  { value: 'audio', label: 'audio — sound clip' },
  { value: 'clozeSentences', label: 'cloze sentences — ⟦blank⟧ examples' },
];

/**
 * The item-type designer: fields and card templates for a course's content
 * model. Saving migrates every existing item of the type, so the impact is
 * spelled out before the user commits.
 */
export function ItemTypeDesigner({ course, types }: { course: Course; types: ItemType[] }) {
  const [editing, setEditing] = useState<ItemType | null>(null);
  const [error, setError] = useState('');
  const counts = useLiveQuery(async () => {
    const entries = await Promise.all(
      types.map(async (t) => [t.id, await db.items.where('typeId').equals(t.id).count()] as const),
    );
    return new Map(entries);
  }, [types.map((t) => t.id).join()]);

  return (
    <Panel
      title="Item types"
      actions={
        <Button
          onClick={async () => {
            setError('');
            try {
              setEditing(await createBlankItemType(course.id, now()));
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          + New type
        </Button>
      }
    >
      {error && <p className="mb-2 text-sm text-rose-300">{error}</p>}
      <ul className="divide-y divide-slate-800/70">
        {types.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded"
                style={{ backgroundColor: t.color }}
              >
                {t.icon}
              </span>
              <span className="truncate text-sm text-slate-200">{t.name}</span>
              <span className="shrink-0 text-xs text-slate-500">
                {t.fields.length} field{t.fields.length === 1 ? '' : 's'} ·{' '}
                {t.templates.map((tpl) => tpl.name).join(' + ')}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge>{counts?.get(t.id) ?? 0} items</Badge>
              <Button onClick={() => setEditing(t)}>Design</Button>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-slate-500">
        Fields hold content; each template turns fields into one review card (WaniKani's separate
        meaning and reading cards are two templates on one type).
      </p>
      {editing && (
        <TypeDesignerModal
          key={editing.id}
          original={editing}
          itemCount={counts?.get(editing.id) ?? 0}
          canDelete={types.length > 1}
          onClose={() => setEditing(null)}
        />
      )}
    </Panel>
  );
}

function TypeDesignerModal({
  original,
  itemCount,
  canDelete,
  onClose,
}: {
  original: ItemType;
  itemCount: number;
  canDelete: boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ItemType>(() => structuredClone(original));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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

  const toggleId = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  async function save() {
    setBusy(true);
    setError('');
    try {
      await saveItemTypeEdit(draft, now());
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      wide
      title={`Design type · ${original.name}`}
      onClose={onClose}
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
              setBusy(true);
              setError('');
              try {
                await deleteItemType(original.id, now(), { withItems });
                onClose();
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Delete type
          </Button>
          <div className="grow" />
          {error && <span className="mr-2 text-xs text-rose-300">{error}</span>}
          <Button onClick={onClose}>Cancel</Button>
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
      <div className="space-y-5">
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
                  value={f.name}
                  onChange={(e) => setField(f.id, { name: e.target.value })}
                  className="max-w-44"
                />
                <Select
                  value={f.kind}
                  onChange={(e) => setField(f.id, { kind: e.target.value as FieldDef['kind'] })}
                >
                  {FIELD_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </Select>
                <Button variant="ghost" disabled={i === 0} onClick={() => moveField(i, -1)}>
                  ↑
                </Button>
                <Button
                  variant="ghost"
                  disabled={i === draft.fields.length - 1}
                  onClick={() => moveField(i, 1)}
                >
                  ↓
                </Button>
                <Button
                  variant="ghost"
                  title="Remove this field (its values are deleted on save)"
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
                toggleId={toggleId}
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
      </div>
    </Modal>
  );
}

function TemplateEditor({
  template,
  fields,
  onChange,
  onRemove,
  toggleId,
}: {
  template: CardTemplate;
  fields: FieldDef[];
  onChange: (patch: Partial<CardTemplate>) => void;
  onRemove: () => void;
  toggleId: (list: string[], id: string) => string[];
}) {
  const clozeFields = fields.filter((f) => f.kind === 'clozeSentences');
  return (
    <div className="rounded-lg border border-slate-800 p-3">
      <div className="mb-2 flex items-center gap-2">
        <TextInput
          value={template.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="max-w-44"
        />
        <Select
          value={template.grading.mode}
          onChange={(e) => {
            const mode = e.target.value;
            onChange({
              grading:
                mode === 'sentenceCloze'
                  ? {
                      mode: 'sentenceCloze',
                      sentencesFieldId: clozeFields[0]?.id ?? '',
                      rotation: 'random',
                    }
                  : { mode: 'typed', answerLang: 'latin', typoTolerance: true },
            });
          }}
          title="How this card is answered"
        >
          <option value="typed">typed answer</option>
          <option value="sentenceCloze">sentence cloze</option>
        </Select>
        {template.grading.mode === 'typed' && (
          <>
            <Select
              value={template.grading.answerLang}
              onChange={(e) =>
                onChange({
                  grading: {
                    ...template.grading,
                    mode: 'typed',
                    answerLang: e.target.value as 'latin' | 'kana',
                  } as CardTemplate['grading'],
                })
              }
              title="Kana answers turn the input into a romaji→kana IME and are matched exactly"
            >
              <option value="latin">latin</option>
              <option value="kana">kana (IME)</option>
            </Select>
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={template.grading.typoTolerance}
                onChange={(e) =>
                  onChange({
                    grading: {
                      ...template.grading,
                      mode: 'typed',
                      typoTolerance: e.target.checked,
                    } as CardTemplate['grading'],
                  })
                }
              />
              typo tolerance
            </label>
          </>
        )}
        {template.grading.mode === 'sentenceCloze' && (
          <Select
            value={template.grading.rotation}
            onChange={(e) =>
              onChange({
                grading: {
                  ...template.grading,
                  mode: 'sentenceCloze',
                  rotation: e.target.value as 'random' | 'sequential',
                } as CardTemplate['grading'],
              })
            }
            title="Which example sentence each review shows"
          >
            <option value="random">random sentence</option>
            <option value="sequential">in order</option>
          </Select>
        )}
        <div className="grow" />
        <Button variant="ghost" onClick={onRemove} title="Remove this template (deletes its cards)">
          ✕
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Prompt (shown)">
          <div className="space-y-1">
            {fields.map((f) => (
              <label key={f.id} className="flex items-center gap-1.5 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={template.promptFieldIds.includes(f.id)}
                  onChange={() => onChange({ promptFieldIds: toggleId(template.promptFieldIds, f.id) })}
                />
                {f.name}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Answer (typed)">
          <Select
            value={template.answerFieldId}
            onChange={(e) => onChange({ answerFieldId: e.target.value })}
            className="w-full"
          >
            <option value="">— pick a field —</option>
            {fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
          {template.grading.mode === 'sentenceCloze' && (
            <span className="mt-2 block">
              <span className="mb-1 block text-xs text-slate-400">Sentences field</span>
              <Select
                value={template.grading.sentencesFieldId}
                onChange={(e) =>
                  onChange({
                    grading: {
                      ...template.grading,
                      mode: 'sentenceCloze',
                      sentencesFieldId: e.target.value,
                    } as CardTemplate['grading'],
                  })
                }
                className="w-full"
              >
                <option value="">— pick a cloze field —</option>
                {clozeFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </span>
          )}
        </Field>
        <Field label="Hints (revealed on request)">
          <div className="space-y-1">
            {fields.map((f) => (
              <label key={f.id} className="flex items-center gap-1.5 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={template.hintFieldIds.includes(f.id)}
                  onChange={() => onChange({ hintFieldIds: toggleId(template.hintFieldIds, f.id) })}
                />
                {f.name}
              </label>
            ))}
          </div>
        </Field>
      </div>
    </div>
  );
}
