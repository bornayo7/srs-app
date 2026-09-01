import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { Button, Field, Modal, TextArea, TextInput } from '@/components/ui';
import { RichText, RICHTEXT_HELP } from '@/components/RichText';
import { FieldValueInput } from './FieldValueInput';
import { SrsControls } from './SrsControls';
import { itemPreview } from '@/engine/grading/context';
import type { Course, GuidanceAnswer, Item, ItemType, SrsLadder } from '@/engine/types';
import { deleteItem, saveItemEdit } from '@/db/repo/items';
import { generateMnemonic } from '@/ai/generate';
import { aiErrorMessage } from '@/ai/client';
import { useAiReady } from '@/hooks/useAiReady';
import { now } from '@/services/clock';

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
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const aiReady = useAiReady();

  const siblings = useLiveQuery(
    async () =>
      (await db.items.where('courseId').equals(course.id).toArray()).filter((i) => i.id !== item.id),
    [course.id, item.id],
  );
  const types = useLiveQuery(
    () => db.itemTypes.where('courseId').equals(course.id).toArray(),
    [course.id],
  );
  const typeById = new Map((types ?? []).map((t) => [t.id, t]));

  const patch = (over: Partial<Item>) => setDraft({ ...draft, ...over });
  const setTemplateList = (
    key: 'synonyms' | 'blockList',
    templateId: string,
    raw: string,
  ) =>
    patch({
      [key]: {
        ...draft[key],
        [templateId]: raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      },
    } as Partial<Item>);

  const setGuidance = (templateId: string, list: GuidanceAnswer[]) =>
    patch({ guidance: { ...draft.guidance, [templateId]: list } });

  async function save() {
    if (fieldError) {
      setError(fieldError);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await saveItemEdit(
        {
          id: draft.id,
          fieldValues: draft.fieldValues,
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
    }
  }

  async function writeMnemonic() {
    setBusy(true);
    setError('');
    try {
      patch({ note: await generateMnemonic(item.id) });
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      setBusy(false);
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
      onClose={onClose}
      footer={
        <>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              if (!confirm('Delete this item and its history?')) return;
              setBusy(true);
              await deleteItem(item.id, now());
              onClose();
            }}
          >
            Delete item
          </Button>
          <div className="grow" />
          {error && <span className="mr-2 text-xs text-rose-300">{error}</span>}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save item'}
          </Button>
        </>
      }
    >
      <div className="mb-4 flex gap-1 border-b border-slate-800">
        {(
          [
            ['content', 'Content'],
            ['answers', 'Accepted answers'],
            ['srs', 'SRS state'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
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
              <FieldValueInput
                field={f}
                value={draft.fieldValues[f.id]}
                onChange={(v) => patch({ fieldValues: { ...draft.fieldValues, [f.id]: v } })}
                onError={setFieldError}
              />
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

      {tab === 'answers' && (
        <div className="space-y-5">
          {itemType.templates.map((tpl) => {
            const guidance = draft.guidance[tpl.id] ?? [];
            return (
              <section key={tpl.id} className="rounded-lg border border-slate-800 p-3">
                <h3 className="mb-2 text-sm font-semibold text-slate-200">{tpl.name}</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="Also accept (synonyms)"
                    hint="Comma-separated. Graded exactly like the real answer."
                  >
                    <TextInput
                      value={(draft.synonyms[tpl.id] ?? []).join(', ')}
                      onChange={(e) => setTemplateList('synonyms', tpl.id, e.target.value)}
                    />
                  </Field>
                  <Field
                    label="Never accept (block list)"
                    hint="Beats typo tolerance — for near-misses that mean something else."
                  >
                    <TextInput
                      value={(draft.blockList[tpl.id] ?? []).join(', ')}
                      onChange={(e) => setTemplateList('blockList', tpl.id, e.target.value)}
                    />
                  </Field>
                </div>

                <div className="mt-3">
                  <div className="mb-1 text-xs text-slate-400">
                    Guidance answers — retry with a nudge instead of a penalty
                  </div>
                  {guidance.map((g, i) => (
                    <div key={i} className="mb-1.5 flex gap-2">
                      <TextInput
                        value={g.text}
                        placeholder="answer typed"
                        className="max-w-48"
                        onChange={(e) =>
                          setGuidance(
                            tpl.id,
                            guidance.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                          )
                        }
                      />
                      <TextInput
                        value={g.message}
                        placeholder="Almost — we want the noun form"
                        onChange={(e) =>
                          setGuidance(
                            tpl.id,
                            guidance.map((x, j) =>
                              j === i ? { ...x, message: e.target.value } : x,
                            ),
                          )
                        }
                      />
                      <Button
                        variant="ghost"
                        onClick={() =>
                          setGuidance(
                            tpl.id,
                            guidance.filter((_, j) => j !== i),
                          )
                        }
                      >
                        ✕
                      </Button>
                    </div>
                  ))}
                  <Button
                    onClick={() => setGuidance(tpl.id, [...guidance, { text: '', message: '' }])}
                  >
                    + Add guidance answer
                  </Button>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {tab === 'srs' && <SrsControls item={item} itemType={itemType} ladder={ladder} />}
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
      <Button variant="ghost" title="Edit this item" onClick={() => setOpen(true)}>
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
