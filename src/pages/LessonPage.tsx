import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { db, requestPersistentStorage } from '@/db/db';
import type { Item, ItemType } from '@/engine/types';
import { clozeSummary, isClozeSentences } from '@/engine/grading/cloze';
import {
  overrideFeedback,
  practiceFeedback,
  type Feedback,
  type QuestionProblem,
  type SessionEntry,
} from '@/engine/question';
import { seededShuffle, mulberry32 } from '@/engine/queue';
import { newId } from '@/engine/ids';
import { completeLessonBatch, lessonAvailability, nextLessonBatch } from '@/services/lessons';
import { prepareQuestions } from '@/services/questions';
import { studyRevision } from '@/services/studyRevision';
import { now } from '@/services/clock';
import { maybeRefreshSnapshot } from '@/exchange/exchange';
import { speak, stopSpeaking, ttsSupported } from '@/services/tts';
import { Button, Badge } from '@/components/ui';
import { RichText } from '@/components/RichText';
import { richTextToPlain } from '@/engine/richtext';
import { AnswerInput } from '@/components/review/AnswerInput';
import { CardPrompt } from '@/components/review/CardPrompt';
import { QuestionField } from '@/components/review/QuestionField';
import { QuestionProblems } from '@/components/review/QuestionProblems';

type Phase =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | {
      kind: 'study';
      items: Item[];
      types: Map<string, ItemType>;
      index: number;
      questions: SessionEntry[];
    }
  | { kind: 'quiz'; queue: SessionEntry[]; taught: SessionEntry[]; total: number }
  | { kind: 'batchDone'; remaining: number; taught: number };

/** A batch keeps the exact questions studied. Finishing cannot activate a later-added card. */
export default function LessonPage() {
  const { courseId } = useParams<{ courseId: string }>();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [problems, setProblems] = useState<QuestionProblem[]>([]);
  const [batchError, setBatchError] = useState('');
  const [busy, setBusy] = useState(false);
  const loadGeneration = useRef(0);
  const saving = useRef(false);
  const feedbackLock = useRef(false);

  const loadBatch = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const stale = () => generation !== loadGeneration.current;
    setPhase({ kind: 'loading' });
    setProblems([]);
    setFeedback(null);
    setBatchError('');
    setBusy(false);
    saving.current = false;
    feedbackLock.current = false;
    if (!courseId) {
      setPhase({ kind: 'none' });
      return;
    }
    try {
      const batch = await nextLessonBatch(courseId, now());
      if (stale()) return;
      if (!batch.length) {
        setPhase({ kind: 'none' });
        return;
      }
      const cards = (
        await db.cards
          .where('itemId')
          .anyOf(batch.map((i) => i.id))
          .toArray()
      ).filter((c) => c.state === 'new' && !c.isGhost);
      const prepared = await prepareQuestions(cards, now() & 0x7fffffff);
      if (stale()) return;
      setProblems(prepared.problems);
      const itemById = new Map(prepared.entries.map((e) => [e.item.id, e.item]));
      const items = batch.flatMap((i) => (itemById.has(i.id) ? [itemById.get(i.id)!] : []));
      const types = new Map(prepared.entries.map((e) => [e.itemType.id, e.itemType]));
      if (!items.length) {
        setPhase({ kind: 'none' });
        return;
      }
      setPhase({ kind: 'study', items, types, index: 0, questions: prepared.entries });
    } catch (err) {
      if (!stale())
        setPhase({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Could not load lessons.',
        });
    }
  }, [courseId]);

  useEffect(() => {
    void loadBatch();
    return () => {
      loadGeneration.current++;
      stopSpeaking();
    };
  }, [loadBatch]);

  async function finishBatch(taught: SessionEntry[]) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    const generation = loadGeneration.current;
    try {
      await completeLessonBatch(
        taught.map((e) => ({
          cardId: e.card.id,
          expected: studyRevision(e.card, e.item, e.itemType),
        })),
        newId(),
        now(),
      );
      if (generation !== loadGeneration.current) return;
      void requestPersistentStorage();
      void maybeRefreshSnapshot(now());
      setBatchError('');
      setFeedback(null);
      setPhase({ kind: 'batchDone', remaining: 0, taught: taught.length });
      // The batch is durable already. A failed availability refresh must never
      // ask the learner to submit it a second time.
      try {
        const avail = courseId ? await lessonAvailability(courseId, now()) : null;
        if (generation === loadGeneration.current)
          setPhase({ kind: 'batchDone', remaining: avail?.available ?? 0, taught: taught.length });
      } catch {
        if (generation === loadGeneration.current)
          setBatchError('Your batch was saved. Reload lessons to check the next allowance.');
      }
    } catch (err) {
      if (generation === loadGeneration.current)
        setBatchError(err instanceof Error ? err.message : 'Could not save this batch. Try again.');
    } finally {
      if (generation === loadGeneration.current) {
        saving.current = false;
        setBusy(false);
      }
    }
  }

  if (phase.kind === 'loading')
    return (
      <p role="status" className="py-16 text-center text-slate-500">
        Loading lessons…
      </p>
    );
  if (phase.kind === 'error')
    return (
      <div role="alert" className="py-16 text-center">
        <p>{phase.message}</p>
        <Button onClick={() => void loadBatch()}>Try again</Button>
      </div>
    );
  if (phase.kind === 'none')
    return (
      <div className="mx-auto max-w-xl py-12 text-center">
        <h1 className="text-xl font-semibold">
          {problems.length ? 'These lessons need attention' : 'No lessons available right now'}
        </h1>
        <p className="mt-2 text-slate-400">
          {problems.length
            ? 'Repair the listed questions, then reload the batch.'
            : "The pool is empty or today's allowance is used."}
        </p>
        <QuestionProblems problems={problems} courseId={courseId!} />
        <div className="mt-4 flex justify-center gap-3">
          <Button onClick={() => void loadBatch()}>Reload lessons</Button>
          <Link className="p-2 text-violet-300" to={`/course/${courseId}`}>
            Back to course
          </Link>
        </div>
      </div>
    );
  if (phase.kind === 'batchDone')
    return (
      <div className="mx-auto max-w-xl py-12 text-center">
        <h1 className="text-xl font-semibold">Batch complete</h1>
        <p className="mt-2 text-slate-300">
          {phase.taught} questions scheduled for their first review.
        </p>
        {batchError && (
          <p role="status" className="mt-2 text-sm">
            {batchError}
          </p>
        )}
        <QuestionProblems problems={problems} courseId={courseId!} />
        <div className="mt-4 flex justify-center gap-3">
          {phase.remaining > 0 && (
            <Button variant="primary" onClick={() => void loadBatch()}>
              Next batch · {phase.remaining} available
            </Button>
          )}
          <Link className="p-2 text-violet-300" to="/">
            Done
          </Link>
        </div>
      </div>
    );

  if (phase.kind === 'study') {
    const item = phase.items[phase.index];
    const type = phase.types.get(item.typeId)!;
    return (
      <div className="mx-auto max-w-xl">
        <QuestionProblems problems={problems} courseId={courseId!} />
        <div className="mb-3 flex items-center justify-between text-sm text-slate-400">
          <span>
            Lesson {phase.index + 1} / {phase.items.length}
          </span>
          <Badge color="violet">Study</Badge>
        </div>
        <div
          key={item.id}
          className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900"
        >
          <div
            className="px-4 py-2 text-sm font-semibold text-white"
            style={{ backgroundColor: type.color }}
          >
            {type.icon} {type.name}
          </div>
          <div className="space-y-5 p-6">
            {type.fields.map((field) => {
              const value = item.fieldValues[field.id];
              if (value === undefined || value === '' || (Array.isArray(value) && !value.length))
                return null;
              const text = isClozeSentences(value)
                ? clozeSummary(value)
                : typeof value === 'string'
                  ? value
                  : value.join(', ');
              const readable = field.kind !== 'image' && field.kind !== 'audio';
              return (
                <div key={field.id}>
                  <div className="mb-1 text-sm font-medium text-slate-400">{field.name}</div>
                  <div className="study-prompt text-xl leading-relaxed text-slate-100">
                    <QuestionField kind={field.kind} value={value} name={field.name} />
                  </div>
                  {readable && ttsSupported() && (
                    <button
                      type="button"
                      className="mt-1 rounded bg-slate-800 px-2 py-1 text-sm"
                      aria-label={`Read ${field.name} aloud`}
                      onClick={() => speak(richTextToPlain(text))}
                    >
                      Read aloud
                    </button>
                  )}
                </div>
              );
            })}
            {item.note && (
              <div className="rounded-lg bg-slate-950/60 p-3 text-sm">
                <span className="mr-2 font-medium">Note</span>
                <RichText src={item.note} />
              </div>
            )}
          </div>
        </div>
        <div className="mt-4 flex justify-between gap-3">
          <Button
            disabled={phase.index === 0}
            onClick={() => {
              stopSpeaking();
              setPhase({ ...phase, index: phase.index - 1 });
            }}
          >
            Back
          </Button>
          {phase.index === phase.items.length - 1 ? (
            <Button
              variant="primary"
              onClick={() => {
                stopSpeaking();
                feedbackLock.current = false;
                setFeedback(null);
                setPhase({
                  kind: 'quiz',
                  queue: seededShuffle(phase.questions, mulberry32(now() & 0x7fffffff)),
                  taught: phase.questions,
                  total: phase.questions.length,
                });
              }}
            >
              Quiz the batch
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => {
                stopSpeaking();
                setPhase({ ...phase, index: phase.index + 1 });
              }}
            >
              Next
            </Button>
          )}
        </div>
      </div>
    );
  }

  const entry = phase.queue[0];
  if (!entry) return null;
  return (
    <div className="mx-auto max-w-xl">
      <QuestionProblems problems={problems} courseId={courseId!} />
      <div className="mb-3 flex items-center justify-between gap-3 text-sm text-slate-400">
        <span>
          Quiz {phase.total - phase.queue.length} / {phase.total}
        </span>
        <Badge color="amber">Lesson quiz</Badge>
      </div>
      <CardPrompt key={entry.card.id} entry={entry} feedback={feedback} />
      <div className="mt-5">
        <AnswerInput
          key={entry.card.id}
          entry={entry}
          feedback={feedback}
          busy={busy}
          onOverride={(correct) => {
            if (saving.current || !feedbackLock.current) return;
            setFeedback(overrideFeedback(entry, correct));
          }}
          onSubmit={(text) => {
            if (feedbackLock.current || saving.current) return;
            const next = practiceFeedback(entry, text);
            feedbackLock.current = next.kind !== 'retry';
            setFeedback(next);
          }}
          onContinue={() => {
            if (saving.current || !feedbackLock.current) return;
            const [current, ...rest] = phase.queue;
            if (feedback?.kind === 'correct' && rest.length === 0) {
              void finishBatch(phase.taught);
              return;
            }
            feedbackLock.current = false;
            setPhase({ ...phase, queue: feedback?.kind === 'correct' ? rest : [...rest, current] });
            setFeedback(null);
          }}
        />
      </div>
      {batchError && (
        <div role="alert" className="mt-4 text-sm text-rose-300">
          <p>{batchError}</p>
          <Button className="mt-2" onClick={() => void loadBatch()}>
            Reload batch
          </Button>
        </div>
      )}
      <p className="mt-3 text-center text-sm text-slate-400">
        Answer every question correctly once to schedule this batch.
      </p>
    </div>
  );
}
