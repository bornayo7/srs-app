import { db } from '@/db/db';
import { newId } from '@/engine/ids';
import type { Card, CardSnapshot, ReviewLog, ReviewOutcome } from '@/engine/types';
import { schedulerForCourse } from './schedulers';

export interface CommitReviewInput {
  cardId: string;
  sessionId: string;
  outcome: ReviewOutcome;
  now: number;
}

export interface CommitReviewResult {
  logId: string;
  card: Card;
  fromStage: number | null;
  toStage: number | null;
  burned: boolean;
}

type PostCommitHook = (args: { card: Card; now: number }) => Promise<void>;

/**
 * Ordered hooks run inside the same transaction after the card is written.
 * P2 slots prerequisite-gating and level-up cascades in here without touching
 * the write path itself.
 */
const postCommitHooks: PostCommitHook[] = [];
export function registerPostCommitHook(hook: PostCommitHook): void {
  postCommitHooks.push(hook);
}

/**
 * THE atomic write path for a review answer:
 * applyReview → write card → append log (with full prev snapshot) → hooks.
 * Everything in one rw transaction — a failure anywhere rolls back all of it.
 */
export async function commitReview(input: CommitReviewInput): Promise<CommitReviewResult> {
  return db.transaction(
    'rw',
    [db.cards, db.items, db.courses, db.ladders, db.reviewLogs],
    async () => {
      const card = await db.cards.get(input.cardId);
      if (!card) throw new Error(`card not found: ${input.cardId}`);
      if (card.state !== 'review' || card.srs === null) {
        throw new Error(`card is not reviewable (state=${card.state})`);
      }
      const course = await db.courses.get(card.courseId);
      if (!course) throw new Error(`course not found: ${card.courseId}`);
      const { scheduler } = await schedulerForCourse(course);

      const prev: CardSnapshot = {
        state: card.state,
        srs: structuredClone(card.srs),
        ...(card.dueAt !== undefined ? { dueAt: card.dueAt } : {}),
        stats: { ...card.stats },
      };

      const fromStage = card.srs.kind === 'ladder' ? card.srs.stageIndex : null;
      const applied = scheduler.applyReview(card.srs, input.outcome, input.now);
      const incorrect =
        input.outcome.kind === 'ladder'
          ? input.outcome.incorrectCount > 0
          : input.outcome.rating === 1;

      const updated: Card = {
        ...card,
        srs: applied.srs,
        state: applied.dueAt === null ? 'burned' : 'review',
        stats: {
          reviews: card.stats.reviews + 1,
          correct: card.stats.correct + (incorrect ? 0 : 1),
          lapses: card.stats.lapses + (incorrect ? 1 : 0),
        },
        updatedAt: input.now,
      };
      if (applied.dueAt === null) {
        delete updated.dueAt; // absent, not null — keeps it out of the due indexes
      } else {
        updated.dueAt = applied.dueAt;
      }
      await db.cards.put(updated);

      const toStage = applied.srs.kind === 'ladder' ? applied.srs.stageIndex : null;
      const log: ReviewLog = {
        id: newId(),
        cardId: card.id,
        itemId: card.itemId,
        courseId: card.courseId,
        ts: input.now,
        sessionId: input.sessionId,
        kind: 'review',
        outcome:
          input.outcome.kind === 'ladder'
            ? {
                kind: 'ladder',
                incorrectCount: input.outcome.incorrectCount,
                fromStage: fromStage ?? 0,
                toStage: toStage ?? 0,
              }
            : {
                kind: 'fsrs',
                rating: input.outcome.rating,
                elapsedDays: 0,
                scheduledDays: 0,
              },
        prev,
      };
      await db.reviewLogs.add(log);

      for (const hook of postCommitHooks) {
        await hook({ card: updated, now: input.now });
      }

      return {
        logId: log.id,
        card: updated,
        fromStage,
        toStage,
        burned: applied.dueAt === null,
      };
    },
  );
}
