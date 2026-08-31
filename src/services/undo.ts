import { db } from '@/db/db';
import type { Card } from '@/engine/types';

/**
 * Single-step undo: restore the card from the log's prev snapshot and delete
 * the log. Unlock/level-up cascades are deliberately NOT reverted (documented
 * product decision — passedAt is sticky).
 */
export async function undoReview(logId: string): Promise<Card | null> {
  return db.transaction('rw', [db.cards, db.reviewLogs], async () => {
    const log = await db.reviewLogs.get(logId);
    if (!log || log.kind !== 'review') return null;
    const card = await db.cards.get(log.cardId);
    if (!card) return null;

    const restored: Card = {
      ...card,
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
    await db.reviewLogs.delete(logId);
    return restored;
  });
}
