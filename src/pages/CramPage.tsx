import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import Dexie from 'dexie';
import { db } from '@/db/db';
import type { Card } from '@/engine/types';
import { mulberry32, seededShuffle } from '@/engine/queue';
import { DAY } from '@/engine/time';
import {
  overrideFeedback,
  practiceFeedback,
  type Feedback,
  type SessionEntry,
  type QuestionProblem,
} from '@/engine/question';
import { prepareQuestions } from '@/services/questions';
import { QuestionProblems } from '@/components/review/QuestionProblems';
import { CardPrompt } from '@/components/review/CardPrompt';
import { AnswerInput } from '@/components/review/AnswerInput';
import { Badge, Button, ButtonLink } from '@/components/ui';
import { now } from '@/services/clock';

export type CramScope = 'learned' | 'leeches' | 'misses';

const SCOPE_LABEL: Record<CramScope, string> = {
  learned: 'everything learned',
  leeches: 'leeches (3+ lapses)',
  misses: 'missed this week',
};

async function buildPool(courseId: string, scope: CramScope): Promise<Card[]> {
  const all = await db.cards
    .where('[courseId+state]')
    .between([courseId, Dexie.minKey], [courseId, Dexie.maxKey])
    .toArray();
  const learned = all.filter((c) => !c.isGhost && (c.state === 'review' || c.state === 'burned'));
  if (scope === 'learned') return learned;
  if (scope === 'leeches') return learned.filter((c) => c.stats.lapses >= 3);
  // misses: cards answered wrong in the last 7 days — a miss on a GHOST maps
  // back to its parent card, so ghost-drilled material shows up here too
  const since = now() - 7 * DAY;
  const logs = await db.reviewLogs
    .where('[courseId+ts]')
    .between([courseId, since], [courseId, Infinity])
    .toArray();
  const missedIds = new Set(
    logs
      .filter(
        (l) => l.kind === 'review' && l.outcome?.kind === 'ladder' && l.outcome.incorrectCount > 0,
      )
      .map((l) =>
        l.cardMeta?.isGhost && l.cardMeta.parentCardId ? l.cardMeta.parentCardId : l.cardId,
      ),
  );
  return learned.filter((c) => missedIds.has(c.id));
}

/**
 * Cram / extra study (Bunpro-style): drill any slice of a course with ZERO
 * SRS effect — nothing here ever calls commitReview.
 */
export default function CramPage() {
  const { courseId } = useParams<{ courseId: string }>();
  const [params] = useSearchParams();
  const rawScope = params.get('scope');
  const scope: CramScope = rawScope === 'leeches' || rawScope === 'misses' ? rawScope : 'learned';

  const [phase, setPhase] = useState<'loading' | 'empty' | 'active' | 'done' | 'error'>('loading');
  const [queue, setQueue] = useState<SessionEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [misses, setMisses] = useState<Set<string>>(new Set());
  const [problems, setProblems] = useState<QuestionProblem[]>([]);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // a build still in flight when the course or scope changes must not show the old pool
  const loadGeneration = useRef(0);
  const feedbackLock = useRef(false);

  const start = useCallback(async () => {
    if (!courseId) return;
    const generation = ++loadGeneration.current;
    const stale = () => generation !== loadGeneration.current;
    setPhase('loading');
    setFeedback(null);
    setMisses(new Set());
    setProblems([]);
    setError('');
    feedbackLock.current = false;
    try {
      const pool = await buildPool(courseId, scope);
      if (stale()) return;
      if (pool.length === 0) {
        setPhase('empty');
        return;
      }
      const seed = Date.now() & 0x7fffffff;
      const prepared = await prepareQuestions(pool, seed);
      if (stale()) return;
      const shuffled = seededShuffle(prepared.entries, mulberry32(seed));
      setProblems(prepared.problems);
      setQueue(shuffled);
      setTotal(shuffled.length);
      setPhase(shuffled.length === 0 ? 'empty' : 'active');
    } catch (err) {
      if (!stale()) {
        setError(err instanceof Error ? err.message : 'Could not load extra study.');
        setPhase('error');
      }
    }
  }, [courseId, scope]);

  useEffect(() => {
    void start();
    return () => {
      loadGeneration.current++;
    };
  }, [start]);

  if (phase === 'loading') {
    return <p className="py-16 text-center text-slate-500">Building cram session…</p>;
  }
  if (phase === 'error')
    return (
      <div role="alert" className="py-12 text-center">
        <p>{error}</p>
        <Button onClick={() => void start()}>Try again</Button>
      </div>
    );
  if (phase === 'empty') {
    return (
      <div className="py-16 text-center">
        <div className="text-4xl">🎯</div>
        <p className="mt-2 text-slate-300">
          {problems.length
            ? 'No available questions in this session.'
            : `Nothing to cram for “${SCOPE_LABEL[scope]}”.`}
        </p>
        <QuestionProblems problems={problems} courseId={courseId!} />
        <ButtonLink to={`/course/${courseId}`} className="mt-4">
          Back to course
        </ButtonLink>
      </div>
    );
  }
  if (phase === 'done') {
    return (
      <div className="py-16 text-center">
        <div className="text-4xl">💪</div>
        <p className="mt-2 text-slate-200">
          Crammed {total} card{total === 1 ? '' : 's'} — {misses.size} needed retries.
        </p>
        <p className="mt-1 text-xs text-slate-500">No SRS state was changed.</p>
        <QuestionProblems problems={problems} courseId={courseId!} />
        <div className="mt-4 flex justify-center gap-2">
          <Button variant="primary" onClick={() => void start()}>
            Again
          </Button>
          <ButtonLink to={`/course/${courseId}`}>Done</ButtonLink>
        </div>
      </div>
    );
  }

  const entry = queue[0];
  if (!entry) return null;
  const done = total - queue.length;

  return (
    <div className="mx-auto max-w-xl">
      <QuestionProblems problems={problems} courseId={courseId!} />
      <div className="mb-3 flex items-center justify-between text-xs text-slate-500">
        <span>
          Cram {done} / {total} · {SCOPE_LABEL[scope]}
        </span>
        <Badge color="amber">extra study — no SRS effect</Badge>
      </div>
      <CardPrompt key={entry.card.id} entry={entry} feedback={feedback} />
      <div className="mt-5">
        <AnswerInput
          key={entry.card.id}
          entry={entry}
          feedback={feedback}
          onOverride={(correct) => {
            if (!feedbackLock.current) return;
            setFeedback(overrideFeedback(entry, correct));
          }}
          onSubmit={(text) => {
            if (feedbackLock.current) return;
            const next = practiceFeedback(entry, text);
            feedbackLock.current = next.kind !== 'retry';
            setFeedback(next);
          }}
          onContinue={() => {
            if (!feedbackLock.current) return;
            feedbackLock.current = false;
            const [current, ...rest] = queue;
            if (feedback?.kind === 'correct') {
              if (rest.length === 0) setPhase('done');
              setQueue(rest);
            } else if (feedback?.kind === 'incorrect') {
              setMisses((m) => new Set([...m, current.card.id]));
              setQueue([...rest, current]); // recycle to the end
            }
            setFeedback(null);
          }}
        />
      </div>
    </div>
  );
}
