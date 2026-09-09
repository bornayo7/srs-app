import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { Button, Field, Modal, TextArea, TextInput } from '@/components/ui';
import { RichText, RICHTEXT_HELP } from '@/components/RichText';
import { FieldValueInput } from './FieldValueInput';
import { AnswerRulesEditor } from './AnswerRulesEditor';
import { SrsControls } from './SrsControls';
import { itemPreview } from '@/engine/grading/context';
import type { Course, Item, ItemType, SrsLadder } from '@/engine/types';
import { deleteItem, saveItemEdit } from '@/db/repo/items';
import { generateMnemonicForContent } from '@/ai/generate';
import { aiErrorMessage } from '@/ai/client';
import { useAiReady } from '@/hooks/useAiReady';
import { now } from '@/services/clock';
import { useFieldDraft } from './useFieldDraft';

type Tab = 'content' | 'answers' | 'srs';

/**
 * The full editor for one item: its field values, mnemonic, unlock rules,
 * per-template answer handling, and manual SRS control.
 */
export function ItemEditor({
  item,
  itemType,
  course,
  ladder,
  onClose,
}: {
  item: Item;
  itemType: ItemType;
  course: Course;
  ladder: SrsLadder | null;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Item>(() => structuredClone(item));
  const [tab, setTab] = useState<Tab>('content');
  const [error, setError] = useState('');
  const fields = useFieldDraft(itemType, item.fieldValues);
  const noteRevision = useRef(0);
  const [generatedNote, setGeneratedNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const active = useRef(false);
  const aiReady = useAiReady();

  const siblings = useLiveQuery(
    async () =>
      (await db.items.where('courseId').equals(course.id).toArray()).filter(
        (i) => i.id !== item.id,
      ),
    [course.id, item.id],
  );
  const types = useLiveQuery(
    () => db.itemTypes.where('courseId').equals(course.id).toArray(),
    [course.id],
  );
  const typeById = new Map((types ?? []).map((t) => [t.id, t]));

  const patch = (over: Partial<Item>) => {
    if ('note' in over) noteRevision.current++;
    setDraft((current) => ({ ...current, ...over }));
  };

  async function save() {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setSaving(true);
    setError('');
    try {
      const guidanceRows = Object.values(draft.guidance).flat();
      if (guidanceRows.some((g) => !!g.text.trim() !== !!g.message.trim())) {
        throw new Error(
          'Complete both the answer and message for each guidance row, or clear both.',
        );
      }
      await saveItemEdit(
        {
          id: draft.id,
          rev: draft.rev,
          generation: draft.generation,
          fieldValues: fields.validate(),
          prereqIds: draft.prereqIds,
          level: draft.level,
          synonyms: draft.synonyms,
          blockList: draft.blockList,
          // half-typed guidance rows would silently swallow answers
          guidance: Object.fromEntries(
            Object.entries(draft.guidance).map(([tplId, list]) => [
              tplId,
              list.filter((g) => g.text.trim() && g.message.trim()),
            ]),
          ),
          note: draft.note,
        },
        now(),
      );
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setSaving(false);
      active.current = false;
    }
  }

  async function writeMnemonic() {
    if (active.current) return;
    active.current = true;
    const expectedNote = noteRevision.current;
    const expectedFields = fields.revision();
    setBusy(true);
    setError('');
    try {
      const note = await generateMnemonicForContent(itemType, fields.validate());
      if (noteRevision.current === expectedNote && fields.revision() === expectedFields)
        patch({ note });
      else setGeneratedNote(note);
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      setBusy(false);
      active.current = false;
    }
  }

  return (
    <Modal
      wide
      title={
        <span className="flex items-center gap-2">
          <span style={{ color: itemType.color }}>{itemType.icon}</span>
          Edit · {itemPreview(item, itemType)}
        </span>
      }
      onClose={() => {
        if (!saving) onClose();
      }}
      footer={
        <>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              if (!confirm('Delete this item and its history?')) return;
              if (active.current) return;
              active.current = true;
              setBusy(true);
              setSaving(true);
              try {
                await deleteItem(item.id, now());
                onClose();
              } catch (err) {
                setError(err instanceof Error ? err.message : 'The item could not be deleted.');
              } finally {
                active.current = false;
                setBusy(false);
                setSaving(false);
              }
            }}
          >
            Delete item
          </Button>
          <div className="grow" />
          {error && (
            <span role="alert" className="mr-2 text-sm text-rose-300">
              {error}
            </span>
          )}
          <Button disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || fields.busy} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save item'}
          </Button>
        </>
      }
    >
      <fieldset disabled={saving} className="min-w-0">
        <div className="workspace-tabs mb-4" aria-label="Item editor sections">
          {(
            [
              ['content', 'Content'],
              ['answers', 'Accepted answers'],
              ['srs', 'SRS state'],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              aria-pressed={tab === id}
              className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
                tab === id
                  ? 'border-violet-500 text-slate-100'
                  : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'content' && (
          <div className="space-y-3">
            {itemType.fields.map((f) => (
              <Field key={f.id} label={`${f.name} · ${f.kind}`}>
                <FieldValueInput {...fields.fieldProps(f)} />
              </Field>
            ))}

            <Field label="Note / mnemonic" hint={RICHTEXT_HELP}>
              <TextArea
                rows={3}
                value={draft.note}
                onChange={(e) => patch({ note: e.target.value })}
              />
            </Field>
            {draft.note && (
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-300">
                <RichText src={draft.note} />
              </div>
            )}
            {generatedNote && (
              <section className="rounded-lg border border-slate-700 p-3">
                <p className="text-sm">
                  Your draft changed while the mnemonic was being written. Your edits were kept.
                </p>
                <p className="my-2 text-sm text-slate-400">{generatedNote}</p>
                <Button
                  onClick={() => {
                    patch({ note: generatedNote });
                    setGeneratedNote('');
                  }}
                >
                  Use generated mnemonic
                </Button>
              </section>
            )}
            {aiReady && (
              <Button disabled={busy} onClick={() => void writeMnemonic()}>
                ✨ Write a mnemonic with AI
              </Button>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              {course.levelMode === 'levels' && (
                <Field label={`Level (course is on level ${course.currentLevel})`}>
                  <TextInput
                    type="number"
                    min={1}
                    value={draft.level}
                    onChange={(e) => patch({ level: Math.max(1, +e.target.value || 1) })}
                    className="max-w-28"
                  />
                </Field>
              )}
              <Field
                label="Prerequisites — stays locked until these pass"
                hint="ctrl/⌘-click to pick several"
              >
                <select
                  multiple
                  value={draft.prereqIds}
                  onChange={(e) =>
                    patch({ prereqIds: [...e.target.selectedOptions].map((o) => o.value) })
                  }
                  size={Math.min(6, Math.max(3, siblings?.length ?? 3))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-violet-500"
                >
                  {(siblings ?? [])
                    .slice()
                    .sort((a, b) => a.level - b.level || a.createdAt - b.createdAt)
                    .map((it) => {
                      const ity = typeById.get(it.typeId);
                      return (
                        <option key={it.id} value={it.id}>
                          {ity ? `${ity.icon} ${itemPreview(it, ity)}` : it.id}
                        </option>
                      );
                    })}
                </select>
              </Field>
            </div>
          </div>
        )}

        {tab === 'answers' && <AnswerRulesEditor draft={draft} itemType={itemType} patch={patch} />}

        {tab === 'srs' && <SrsControls item={item} itemType={itemType} ladder={ladder} />}
      </fieldset>
    </Modal>
  );
}

/** Small helper so callers don't have to hold the whole selection dance. */
export function ItemEditorButton({
  item,
  itemType,
  course,
  ladder,
}: {
  item: Item;
  itemType: ItemType;
  course: Course;
  ladder: SrsLadder | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        title="Edit this item"
        aria-label={`Edit ${itemPreview(item, itemType)}`}
        onClick={() => setOpen(true)}
      >
        ✎
      </Button>
      {open && (
        <ItemEditor
          item={item}
          itemType={itemType}
          course={course}
          ladder={ladder}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
