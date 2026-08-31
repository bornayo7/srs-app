import { db } from '@/db/db';
import type { SrsLadder, SrsState } from '@/engine/types';

/**
 * Save an edited course ladder and reconcile the course's cards in the same
 * transaction: stage indexes remap by stage id where possible, else clamp.
 * Existing dueAt values are kept — new intervals apply from the next review.
 */
export async function saveLadderEdit(edited: SrsLadder, now: number): Promise<void> {
  if (edited.stages.length === 0) throw new Error('a ladder needs at least one stage');
  if (edited.isPreset || !edited.courseId) throw new Error('presets are read-only — edit the course copy');

  await db.transaction('rw', [db.ladders, db.cards], async () => {
    const previous = await db.ladders.get(edited.id);
    if (!previous) throw new Error('ladder not found');

    const clamped: SrsLadder = {
      ...edited,
      passesAtIndex: Math.min(Math.max(0, edited.passesAtIndex), edited.stages.length - 1),
      updatedAt: now,
    };
    await db.ladders.put(clamped);

    const indexById = new Map(clamped.stages.map((s, i) => [s.id, i]));
    const courseId = clamped.courseId!;

    const cards = await db.cards
      .where('[courseId+state]')
      .equals([courseId, 'review'])
      .toArray();

    for (const card of cards) {
      if (card.isGhost) continue; // ghosts run on the fixed ghost ladder, not this one
      if (card.srs?.kind !== 'ladder') continue;
      const oldStage = previous.stages[card.srs.stageIndex];
      const remapped =
        (oldStage && indexById.get(oldStage.id)) ??
        Math.min(card.srs.stageIndex, clamped.stages.length - 1);
      if (remapped !== card.srs.stageIndex) {
        const srs: SrsState = { kind: 'ladder', stageIndex: remapped };
        await db.cards.put({ ...card, srs, updatedAt: now });
      }
    }
  });
}
