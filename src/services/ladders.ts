import { nextRevision } from '@/engine/revision';
import Dexie from 'dexie';
import { db } from '@/db/db';
import type { SrsLadder, SrsState } from '@/engine/types';
import { recomputeUnlocks } from './gating';

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
  if (edited.isPreset || !edited.courseId)
    throw new Error('presets are read-only — edit the course copy');
  if (
    new Set(edited.stages.map((s) => s.id)).size !== edited.stages.length ||
    edited.stages.some(
      (s) =>
        !s.id || !s.name.trim() || !Number.isFinite(s.intervalMinutes) || s.intervalMinutes <= 0,
    ) ||
    !Number.isInteger(edited.passesAtIndex)
  )
    throw new Error('Every stage needs a unique ID, a name, and a positive interval.');

  await db.transaction('rw', [db.ladders, db.cards, db.items, db.courses], async () => {
    const previous = await db.ladders.get(edited.id);
    if (!previous) throw new Error('ladder not found');
    const course = await db.courses.get(edited.courseId!);
    if (
      previous.isPreset ||
      previous.courseId !== edited.courseId ||
      !course ||
      course.scheduling.kind !== 'ladder' ||
      course.scheduling.ladderId !== edited.id
    )
      throw new Error('This ladder does not belong to the course.');

    const clamped: SrsLadder = {
      ...edited,
      passesAtIndex: Math.min(Math.max(0, edited.passesAtIndex), edited.stages.length - 1),
      updatedAt: now,
    };
    await db.ladders.put(clamped);
    const changed =
      JSON.stringify([previous.stages, previous.passesAtIndex, previous.burnEnabled]) !==
      JSON.stringify([clamped.stages, clamped.passesAtIndex, clamped.burnEnabled]);
    if (!changed) return;

    const indexById = new Map(clamped.stages.map((s, i) => [s.id, i]));
    const courseId = clamped.courseId!;

    const cards = await db.cards
      .where('[courseId+state]')
      .between([courseId, Dexie.minKey], [courseId, Dexie.maxKey])
      .toArray();

    for (const card of cards) {
      if (card.isGhost) continue; // ghosts run on the fixed ghost ladder, not this one
      if (card.srs?.kind !== 'ladder' || card.state === 'new') {
        await db.cards.put({ ...card, rev: nextRevision(card.rev), updatedAt: now });
        continue;
      }
      let remapped: number;
      if (card.state === 'burned') {
        // burned means "past the top" — keep it there as the ladder grows or shrinks
        remapped = clamped.stages.length;
      } else {
        const oldStage = previous.stages[card.srs.stageIndex];
        const byId = oldStage ? indexById.get(oldStage.id) : undefined;
        remapped = byId ?? Math.min(card.srs.stageIndex, clamped.stages.length - 1);
      }
      const srs: SrsState = { kind: 'ladder', stageIndex: remapped };
      await db.cards.put({ ...card, srs, rev: nextRevision(card.rev), updatedAt: now });
    }
    await recomputeUnlocks(courseId, now);
  });
}
