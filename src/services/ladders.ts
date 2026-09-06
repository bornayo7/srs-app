import Dexie from 'dexie';
import { db } from '@/db/db';
import type { SrsLadder, SrsState } from '@/engine/types';

/**
 * Save an edited course ladder and reconcile the course's cards in the same
 * transaction: stage indexes remap by stage id where possible, else clamp.
 * Suspended cards are remapped too — they keep their stage for resuming, and
 * a stale index past the new top would burn them on resume. Burned cards are
 * re-pointed at the new top. Existing dueAt values are kept — new intervals
 * apply from the next review.
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
      .between([courseId, Dexie.minKey], [courseId, Dexie.maxKey])
      .toArray();

    for (const card of cards) {
      if (card.isGhost) continue; // ghosts run on the fixed ghost ladder, not this one
      if (card.srs?.kind !== 'ladder' || card.state === 'new') continue;
      let remapped: number;
      if (card.state === 'burned') {
        // burned means "past the top" — keep it there as the ladder grows or shrinks
        remapped = clamped.stages.length;
      } else {
        const oldStage = previous.stages[card.srs.stageIndex];
        const byId = oldStage ? indexById.get(oldStage.id) : undefined;
        remapped = byId ?? Math.min(card.srs.stageIndex, clamped.stages.length - 1);
      }
      if (remapped !== card.srs.stageIndex) {
        const srs: SrsState = { kind: 'ladder', stageIndex: remapped };
        await db.cards.put({ ...card, srs, updatedAt: now });
      }
    }
  });
}
