import { nextRevision } from '@/engine/revision';
import { db } from '@/db/db';
import type { Card } from '@/engine/types';
import { undoContentStillMatches } from './studyRevision';

/**
 * Single-step undo: restore the card from the log's prev snapshot and delete
 * the log. Unlock/level-up cascades are deliberately NOT reverted (documented
 * product decision — passedAt is sticky).
 */
export async function undoReview(logId: string): Promise<Card | null> {
  return db.transaction(
    'rw',
    [db.cards, db.items, db.itemTypes, db.courses, db.reviewLogs, db.cardTombstones],
    async () => {
      const log = await db.reviewLogs.get(logId);
      if (!log || log.kind !== 'review') return null;
      if (!(await db.courses.get(log.courseId)) || !(await undoContentStillMatches(log)))
        return null;
      let card = await db.cards.get(log.cardId);
      if (
        card &&
        (card.rev !== log.appliedRev ||
          card.generation !== log.appliedGeneration ||
          card.itemId !== log.itemId ||
          card.courseId !== log.courseId ||
          card.templateId !== log.cardMeta?.templateId)
      )
        return null;

      if (!card) {
        // graduated ghosts are deleted on commit — resurrect from the log
        const tombstone = await db.cardTombstones.get(log.cardId);
        const parent =
          log.cardMeta?.parentCardId && (await db.cards.get(log.cardMeta.parentCardId));
        if (
          !log.cardMeta?.isGhost ||
          !log.cardMeta.parentCardId ||
          !tombstone ||
          tombstone.logId !== log.id ||
          tombstone.rev !== log.appliedRev ||
          tombstone.generation !== log.appliedGeneration ||
          tombstone.itemId !== log.itemId ||
          tombstone.courseId !== log.courseId ||
          tombstone.templateId !== log.cardMeta.templateId ||
          !parent ||
          parent.isGhost ||
          parent.itemId !== log.itemId ||
          parent.courseId !== log.courseId ||
          parent.templateId !== log.cardMeta.templateId
        )
          return null;
        card = {
          generation: tombstone.generation,
          rev: tombstone.rev,
          id: log.cardId,
          itemId: log.itemId,
          courseId: log.courseId,
          templateId: log.cardMeta.templateId,
          state: log.prev.state,
          ...(log.cardMeta.isGhost
            ? { isGhost: true, parentCardId: log.cardMeta.parentCardId }
            : {}),
          srs: log.prev.srs,
          stats: { ...log.prev.stats },
          updatedAt: log.ts,
        };
      }

      const restored: Card = {
        ...card,
        rev: nextRevision(card.rev),
        state: log.prev.state,
        srs: log.prev.srs,
        stats: { ...log.prev.stats },
        updatedAt: log.ts,
      };
      if (log.prev.dueAt !== undefined) {
        restored.dueAt = log.prev.dueAt;
      } else {
        delete restored.dueAt;
      }
      await db.cards.put(restored);
      await db.cardTombstones.delete(log.cardId);
      await db.reviewLogs.delete(logId);
      return restored;
    },
  );
}
