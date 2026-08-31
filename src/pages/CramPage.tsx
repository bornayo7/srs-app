import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import Dexie from 'dexie';
import { db } from '@/db/db';
import type { Card, Item, ItemType } from '@/engine/types';
import { matchTypedAnswer } from '@/engine/grading/match';
import { mulberry32, seededShuffle } from '@/engine/queue';
import { DAY } from '@/engine/time';
import { entryMatchContext, withClozePick, type Feedback, type SessionEntry } from '@/stores/sessionStore';
import { CardPrompt } from '@/components/review/CardPrompt';
import { TypedInput } from '@/components/review/TypedInput';
import { Badge, Button } from '@/components/ui';
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
  const learned = all.filter(
    (c) => !c.isGhost && (c.state === 'review' || c.state === 'burned'),
  );
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
      .filter((l) => l.kind === 'review' && l.outcome?.kind === 'ladder' && l.outcome.incorrectCount > 0)
      .map((l) => (l.cardMeta?.isGhost && l.cardMeta.parentCardId ? l.cardMeta.parentCardId : l.cardId)),
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
  const scope: CramScope =
    rawScope === 'leeches' || rawScope === 'misses' ? rawScope : 'learned';

  const [phase, setPhase] = useState<'loading' | 'empty' | 'active' | 'done'>('loading');
  const [queue, setQueue] = useState<SessionEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [missCount, setMissCount] = useState(0);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const start = useCallback(async () => {
    if (!courseId) return;
    setPhase('loading');
    setFeedback(null);
    setMissCount(0);
    const pool = await buildPool(courseId, scope);
    if (pool.length === 0) {
      setPhase('empty');
      return;
    }
    const items = new Map(
      (await db.items.bulkGet([...new Set(pool.map((c) => c.itemId))]))
        .filter((i): i is Item => !!i)
        .map((i) => [i.id, i]),
    );
    const types = new Map(
      (await db.itemTypes.bulkGet([...new Set([...items.values()].map((i) => i.typeId))]))
        .filter((t): t is ItemType => !!t)
        .map((t) => [t.id, t]),
    );
    const seed = Date.now() & 0x7fffffff;
    const entries: SessionEntry[] = [];
    for (const card of pool) {
      const item = items.get(card.itemId);
      const itemType = item && types.get(item.typeId);
      const template = itemType?.templates.find((t) => t.id === card.templateId);
      if (item && itemType && template) {
        entries.push(withClozePick({ card, item, itemType, template }, seed + entries.length));
      }
    }
    const shuffled = seededShuffle(entries, mulberry32(seed));
    setQueue(shuffled);
    setTotal(shuffled.length);
    setPhase(shuffled.length === 0 ? 'empty' : 'active');
  }, [courseId, scope]);

  useEffect(() => {
    void start();
  }, [start]);

  if (phase === 'loading') {
    return <p className="py-16 text-center text-slate-500">Building cram session…</p>;
  }
  if (phase === 'empty') {
    return (
      <div className="py-16 text-center">
        <div className="text-4xl">🎯</div>
        <p className="mt-2 text-slate-300">Nothing to cram for “{SCOPE_LABEL[scope]}”.</p>
        <Link to={`/course/${courseId}`} className="mt-4 inline-block">
          <Button>Back to course</Button>
        </Link>
      </div>
    );
  }
  if (phase === 'done') {
    return (
      <div className="py-16 text-center">
        <div className="text-4xl">💪</div>
        <p className="mt-2 text-slate-200">
          Crammed {total} card{total === 1 ? '' : 's'} — {missCount} needed retries.
        </p>
        <p className="mt-1 text-xs text-slate-500">No SRS state was changed.</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button variant="primary" onClick={() => void start()}>
            Again
          </Button>
          <Link to={`/course/${courseId}`}>
            <Button>Done</Button>
          </Link>
        </div>
      </div>
    );
  }

  const entry = queue[0];
  if (!entry) return null;
  const done = total - queue.length;

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-3 flex items-center justify-between text-xs text-slate-500">
        <span>
          Cram {done} / {total} · {SCOPE_LABEL[scope]}
        </span>
        <Badge color="amber">extra study — no SRS effect</Badge>
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
              setMissCount((m) => m + 1);
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
            const [current, ...rest] = queue;
            if (feedback?.kind === 'correct') {
              if (rest.length === 0) setPhase('done');
              setQueue(rest);
            } else if (feedback?.kind === 'incorrect') {
              setQueue([...rest, current]); // recycle to the end
            }
            setFeedback(null);
          }}
        />
      </div>
    </div>
  );
}
