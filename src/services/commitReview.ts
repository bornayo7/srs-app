import { nextRevision } from '@/engine/revision';
import { db } from '@/db/db';
import { newId } from '@/engine/ids';
import type { Card, CardSnapshot, ReviewLog, ReviewOutcome } from '@/engine/types';
import { ghostScheduler, schedulerForCourse } from './schedulers';
import { maybeSpawnGhost } from './ghosts';
import { applyGatingAfterReview, type GatingOutcome } from './gating';
import { requireStudyRevision, StudyConflict, type StudyRevision } from './studyRevision';

export interface CommitReviewInput {
  cardId: string;
  sessionId: string;
  outcome: ReviewOutcome;
  now: number;
  expected: StudyRevision;
}

export interface CommitReviewResult {
  logId: string;
  card: Card;
  fromStage: number | null;
  toStage: number | null;
  burned: boolean;
  /** Prerequisite/level cascade triggered by this review (never for ghosts). */
  gating: GatingOutcome;
}

/**
 * THE atomic write path for a review answer:
 * applyReview → write card → append log (with full prev snapshot) → hooks.
 * Everything in one rw transaction — a failure anywhere rolls back all of it.
 */
export async function commitReview(input: CommitReviewInput): Promise<CommitReviewResult> {
  return db.transaction(
    'rw',
    [db.cards, db.items, db.itemTypes, db.courses, db.ladders, db.reviewLogs, db.cardTombstones],
    async () => {
      const card = await db.cards.get(input.cardId);
      if (!card)
        throw new StudyConflict('This card was removed or already completed. Reload the session.');
      const { item, type } = await requireStudyRevision(card, input.expected);
      if (card.state !== 'review' || card.srs === null) {
        throw new StudyConflict(`This card is no longer ready for review (${card.state}).`);
      }
      if (card.dueAt === undefined || card.dueAt > input.now)
        throw new StudyConflict('This review is not due yet.');
      if (
        input.outcome.kind === 'ladder' &&
        (!Number.isInteger(input.outcome.incorrectCount) || input.outcome.incorrectCount < 0)
      ) {
        throw new Error('Invalid review outcome.');
      }
      const course = await db.courses.get(card.courseId);
      if (!course) throw new Error(`course not found: ${card.courseId}`);
      // ghosts drill on their own fixed ladder, independent of the course's
      const { scheduler } = card.isGhost
        ? await ghostScheduler()
        : await schedulerForCourse(course);

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
        rev: nextRevision(card.rev),
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
      const ghostGraduated = applied.dueAt === null && card.isGhost === true;
      const logId = newId();
      if (ghostGraduated) {
        // graduating a ghost deletes it — the log's cardMeta allows undo to resurrect
        await db.cards.delete(card.id);
        await db.cardTombstones.put({
          id: card.id,
          itemId: card.itemId,
          courseId: card.courseId,
          templateId: card.templateId,
          rev: updated.rev,
          generation: card.generation,
          logId,
        });
      } else {
        await db.cards.put(updated);
      }

      const toStage = applied.srs.kind === 'ladder' ? applied.srs.stageIndex : null;
      const log: ReviewLog = {
        id: logId,
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
        appliedRev: updated.rev,
        appliedGeneration: card.generation,
        itemRev: item.rev,
        typeRev: type.rev,
        itemGeneration: item.generation,
        typeGeneration: type.generation,
        cardMeta: {
          templateId: card.templateId,
          ...(card.isGhost ? { isGhost: true, parentCardId: card.parentCardId } : {}),
        },
      };
      await db.reviewLogs.add(log);

      // a miss may spawn a drill ghost (policy-gated; never for ghost cards)
      if (input.outcome.kind === 'ladder') {
        await maybeSpawnGhost(course, card, input.outcome.incorrectCount, input.now);
      }

      // ghost drills are practice only — they never pass items or move levels
      const gating = card.isGhost
        ? { itemPassed: false, unlockedItemIds: [], leveledUpTo: null }
        : await applyGatingAfterReview(course, card.itemId, input.now);

      return {
        logId: log.id,
        card: updated,
        fromStage,
        toStage,
        burned: applied.dueAt === null,
        gating,
      };
    },
  );
}
