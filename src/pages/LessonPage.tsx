import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { db } from '@/db/db';
import type { Item, ItemType } from '@/engine/types';
import { matchTypedAnswer } from '@/engine/grading/match';
import { isClozeSentences, revealBlank } from '@/engine/grading/cloze';
import { entryMatchContext, withClozePick, type SessionEntry } from '@/stores/sessionStore';
import { seededShuffle, mulberry32 } from '@/engine/queue';
import { newId } from '@/engine/ids';
import { completeLessonBatch, lessonAvailability, nextLessonBatch } from '@/services/lessons';
import { now } from '@/services/clock';
import { requestPersistentStorage } from '@/db/db';
import { maybeRefreshSnapshot } from '@/exchange/exchange';
import { speak, stopSpeaking, ttsSupported } from '@/services/tts';
import { Button, Badge } from '@/components/ui';
import { TypedInput } from '@/components/review/TypedInput';
import { CardPrompt } from '@/components/review/CardPrompt';
import type { Feedback } from '@/stores/sessionStore';

type Phase =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'study'; items: Item[]; types: Map<string, ItemType>; index: number }
  | {
      kind: 'quiz';
      items: Item[];
      types: Map<string, ItemType>;
      queue: SessionEntry[];
      total: number;
    }
  | { kind: 'batchDone'; remaining: number };

/**
 * Lesson flow: study a batch (read every item), then a quiz gate — each card
 * answered correctly once; wrong answers just recycle. Only completing the
 * batch schedules the items into the review cycle.
 */
export default function LessonPage() {
  const { courseId } = useParams<{ courseId: string }>();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [batchError, setBatchError] = useState('');

  const loadBatch = useCallback(async () => {
    if (!courseId) return;
    const batch = await nextLessonBatch(courseId, now());
    const types = new Map<string, ItemType>();
    for (const it of batch) {
      if (!types.has(it.typeId)) {
        const t = await db.itemTypes.get(it.typeId);
        if (t) types.set(t.id, t);
      }
    }
    // drop items whose type no longer resolves — rendering them would crash
    const teachable = batch.filter((it) => types.has(it.typeId));
    if (teachable.length === 0) {
      setPhase({ kind: 'none' });
      return;
    }
    setPhase({ kind: 'study', items: teachable, types, index: 0 });
  }, [courseId]);

  useEffect(() => {
    void loadBatch();
  }, [loadBatch]);

  // stop any in-flight speech when leaving the lesson flow
  useEffect(() => stopSpeaking, []);

  async function startQuiz(items: Item[], types: Map<string, ItemType>) {
    const seed = Date.now() & 0x7fffffff;
    const entries: SessionEntry[] = [];
    for (const item of items) {
      const itemType = types.get(item.typeId);
      if (!itemType) continue;
      const cards = await db.cards.where('itemId').equals(item.id).toArray();
      for (const card of cards) {
        // skip cards whose template no longer exists on the type
        const template = itemType.templates.find((t) => t.id === card.templateId);
        if (card.state === 'new' && template) {
          entries.push(
            withClozePick({ card, item, itemType, template }, seed + entries.length),
          );
        }
      }
    }
    if (entries.length === 0) {
      // nothing quizzable (e.g. items already activated elsewhere) — complete directly
      await finishBatch(items);
      return;
    }
    const queue = seededShuffle(entries, mulberry32(Date.now() & 0x7fffffff));
    setPhase({ kind: 'quiz', items, types, queue, total: queue.length });
    setFeedback(null);
  }

  async function finishBatch(items: Item[]) {
    try {
      await completeLessonBatch(
        items.map((i) => i.id),
        newId(),
        now(),
      );
    } catch (err) {
      setBatchError(`Could not complete the batch: ${(err as Error).message} — try again.`);
      return;
    }
    setBatchError('');
    void requestPersistentStorage();
    void maybeRefreshSnapshot(now());
    const avail = courseId ? await lessonAvailability(courseId, now()) : null;
    setPhase({ kind: 'batchDone', remaining: avail?.available ?? 0 });
  }

  if (phase.kind === 'loading') {
    return <p className="py-16 text-center text-slate-500">Loading lessons…</p>;
  }

  if (phase.kind === 'none') {
    return (
      <div className="py-16 text-center">
        <div className="text-4xl">📚</div>
        <p className="mt-2 text-slate-300">No lessons available right now.</p>
        <p className="mt-1 text-xs text-slate-500">
          Either the pool is empty or today's new-item limit is reached.
        </p>
        <Link to="/" className="mt-4 inline-block">
          <Button>Back to dashboard</Button>
        </Link>
      </div>
    );
  }

  if (phase.kind === 'batchDone') {
    return (
      <div className="py-16 text-center">
        <div className="text-4xl">✅</div>
        <p className="mt-2 text-slate-200">Batch complete — items scheduled for review.</p>
        <p className="mt-1 text-xs text-slate-500">
          First review lands after the ladder's first interval, on the hour.
        </p>
        <div className="mt-4 flex justify-center gap-2">
          {phase.remaining > 0 && (
            <Button variant="primary" onClick={() => void loadBatch()}>
              Next batch · {phase.remaining} left today
            </Button>
          )}
          <Link to="/">
            <Button>Done</Button>
          </Link>
        </div>
      </div>
    );
  }

  if (phase.kind === 'study') {
    const item = phase.items[phase.index];
    const itemType = phase.types.get(item.typeId)!;
    const last = phase.index === phase.items.length - 1;
    return (
      <div className="mx-auto max-w-xl">
        <div className="mb-3 flex items-center justify-between text-xs text-slate-500">
          <span>
            Lesson {phase.index + 1} / {phase.items.length}
          </span>
          <Badge color="violet">study</Badge>
        </div>
        <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-xl">
          <div
            className="px-4 py-2 text-sm font-semibold text-white/95"
            style={{ backgroundColor: itemType.color }}
          >
            {itemType.icon} {itemType.name}
          </div>
          <div className="space-y-4 px-6 py-6">
            {itemType.fields.map((f) => {
              const v = item.fieldValues[f.id];
              if (isClozeSentences(v)) {
                return (
                  <div key={f.id}>
                    <div className="text-[10px] uppercase tracking-widest text-slate-500">
                      {f.name}
                    </div>
                    <ul className="mt-1 space-y-1.5">
                      {v.map((s, i) => (
                        <li key={i} className="text-base text-slate-100">
                          {revealBlank(s.text)}
                          {s.translation && (
                            <span className="ml-2 text-sm italic text-slate-500">
                              {s.translation}
                            </span>
                          )}
                          {ttsSupported() && (
                            <button
                              className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-xs hover:bg-slate-700"
                              title="Read aloud"
                              onClick={() => speak(revealBlank(s.text))}
                            >
                              🔊
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              }
              const text =
                typeof v === 'string' ? v : Array.isArray(v) ? (v as string[]).join(', ') : '';
              if (!text) return null;
              return (
                <div key={f.id}>
                  <div className="text-[10px] uppercase tracking-widest text-slate-500">
                    {f.name}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-2xl font-semibold text-slate-50">{text}</div>
                    {ttsSupported() && (
                      <button
                        className="rounded bg-slate-800 px-1.5 py-0.5 text-xs hover:bg-slate-700"
                        title="Read aloud"
                        onClick={() => speak(text)}
                      >
                        🔊
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {item.note && (
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-300">
                <span className="mr-1 text-xs uppercase tracking-widest text-slate-500">note</span>
                {item.note}
              </div>
            )}
          </div>
        </div>
        <div className="mt-4 flex justify-between">
          <Button
            disabled={phase.index === 0}
            onClick={() => setPhase({ ...phase, index: phase.index - 1 })}
          >
            ← Back
          </Button>
          {last ? (
            <Button variant="primary" onClick={() => void startQuiz(phase.items, phase.types)}>
              Quiz the batch →
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setPhase({ ...phase, index: phase.index + 1 })}>
              Next →
            </Button>
          )}
        </div>
      </div>
    );
  }

  // quiz
  const entry = phase.queue[0];
  if (!entry) return null;
  const done = phase.total - phase.queue.length;

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-3 flex items-center justify-between text-xs text-slate-500">
        <span>
          Quiz {done} / {phase.total}
        </span>
        <Badge color="amber">lesson quiz — no SRS effect</Badge>
      </div>
      <CardPrompt key={entry.card.id} entry={entry} feedback={feedback} />
      <div className="mt-5">
        <TypedInput
          feedback={feedback}
          onSubmit={(text) => {
            const ctx = entryMatchContext(entry);
            const v = matchTypedAnswer(text, ctx);
            if (v.verdict === 'retry') {
              setFeedback({ kind: 'retry', reason: v.reason, message: v.message, nonce: Date.now() });
            } else if (v.verdict === 'incorrect') {
              setFeedback({ kind: 'incorrect', accepted: ctx.accepted });
            } else {
              setFeedback({
                kind: 'correct',
                typo: v.verdict === 'correctWithTypo',
                toStage: null,
                burned: false,
              });
            }
          }}
          onContinue={() => {
            const [current, ...rest] = phase.queue;
            if (feedback?.kind === 'correct') {
              if (rest.length === 0) {
                void finishBatch(phase.items);
              } else {
                setPhase({ ...phase, queue: rest });
              }
            } else if (feedback?.kind === 'incorrect') {
              setPhase({ ...phase, queue: [...rest, current] }); // recycle to the end
            }
            setFeedback(null);
          }}
        />
      </div>
      {batchError && <p className="mt-3 text-center text-sm text-rose-300">{batchError}</p>}
      <p className="mt-3 text-center text-xs text-slate-500">
        Answer every card correctly once to finish the batch.
      </p>
    </div>
  );
}
