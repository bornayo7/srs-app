import { db } from '@/db/db';
import { newId } from '@/engine/ids';
import { DAY } from '@/engine/time';
import type { Card, Course } from '@/engine/types';
import { ghostScheduler } from './schedulers';

/**
 * Bunpro-style ghosts: a missed card spawns a lightweight drill copy on the
 * short ghost ladder. The ghost is a real due card (queue + forecast) but is
 * invisible to gating/levels, and graduating its ladder DELETES it.
 * Policies: 'on' = every miss; 'minimal' = 2+ misses within 7 days; 'off'.
 * Runs inside the commitReview transaction, after the miss has been logged.
 */
export async function maybeSpawnGhost(
  course: Course,
  parentCard: Card,
  incorrectCount: number,
  now: number,
): Promise<Card | null> {
  if (incorrectCount === 0 || parentCard.isGhost || course.ghosts === 'off') return null;

  const siblings = await db.cards.where('itemId').equals(parentCard.itemId).toArray();
  const hasLiveGhost = siblings.some(
    (c) => c.isGhost && c.parentCardId === parentCard.id && c.state === 'review',
  );
  if (hasLiveGhost) return null;

  if (course.ghosts === 'minimal') {
    const logs = await db.reviewLogs.where('cardId').equals(parentCard.id).toArray();
    // the current miss is already logged, so >= 2 means "second recent miss"
    const recentMisses = logs.filter(
      (l) =>
        l.kind === 'review' &&
        l.ts >= now - 7 * DAY &&
        l.outcome?.kind === 'ladder' &&
        l.outcome.incorrectCount > 0,
    ).length;
    if (recentMisses < 2) return null;
  }

  const { scheduler } = await ghostScheduler();
  const init = scheduler.initialState(now);
  const ghost: Card = {
    id: newId(),
    itemId: parentCard.itemId,
    courseId: parentCard.courseId,
    templateId: parentCard.templateId,
    state: 'review',
    isGhost: true,
    parentCardId: parentCard.id,
    srs: init.srs,
    dueAt: init.dueAt,
    stats: { reviews: 0, correct: 0, lapses: 0 },
    updatedAt: now,
  };
  await db.cards.add(ghost);
  return ghost;
}
