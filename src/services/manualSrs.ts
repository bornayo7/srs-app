import Dexie from 'dexie';
import { db } from '@/db/db';
import { newId } from '@/engine/ids';
import { dueForStage } from '@/engine/scheduler/ladder';
import type { Card, CardSnapshot, ReviewLog, SrsLadder } from '@/engine/types';
import { applyGatingAfterReview, recomputeUnlocks, type GatingOutcome } from './gating';

/**
 * Manual SRS control: put a card at any stage, send it back to lessons,
 * suspend it, or burn it outright. Every change writes a `kind:'manual'`
 * ReviewLog carrying the full previous snapshot, so the history stays honest
 * and a mis-click is one undo away.
 */

export type ManualAction =
  | { kind: 'setStage'; stageIndex: number }
  | { kind: 'reset' }
  | { kind: 'suspend' }
  | { kind: 'resume' }
  | { kind: 'burn' };

export interface ManualResult {
  sessionId: string; // groups the logs of one operation — undo works on the group
  cardsChanged: number;
  gating: GatingOutcome;
}

const NO_GATING: GatingOutcome = { itemPassed: false, unlockedItemIds: [], leveledUpTo: null };

/** Stage choices for a picker: every real stage, plus New and (if enabled) Burned. */
export function stageOptions(ladder: SrsLadder): { value: number; label: string }[] {
  const stages = ladder.stages.map((s, i) => ({ value: i, label: `${i + 1}. ${s.name}` }));
  return ladder.burnEnabled
    ? [...stages, { value: ladder.stages.length, label: '🔥 Burned' }]
    : stages;
}

function applyAction(card: Card, action: ManualAction, ladder: SrsLadder, now: number): Card {
  const top = ladder.stages.length;
  const next: Card = { ...card, updatedAt: now };
  delete next.dueAt; // re-added below only where the state calls for it

  switch (action.kind) {
    case 'reset':
      next.state = 'new';
      next.srs = null;
      return next;

    case 'suspend':
      next.state = 'suspended';
      return next; // srs kept, so resuming restores the stage

    case 'burn':
      next.state = 'burned';
      next.srs = { kind: 'ladder', stageIndex: top };
      return next;

    case 'resume': {
      if (card.srs?.kind !== 'ladder') {
        next.state = 'new';
        next.srs = null;
        return next;
      }
      if (card.srs.stageIndex >= top) {
        next.state = 'burned';
        return next;
      }
      next.state = 'review';
      next.dueAt = now; // resume means "review it now", not "wait another interval"
      return next;
    }

    case 'setStage': {
      const idx = Math.max(0, Math.min(action.stageIndex, top));
      if (idx >= top) {
        next.state = 'burned';
        next.srs = { kind: 'ladder', stageIndex: top };
        return next;
      }
      next.state = 'review';
      next.srs = { kind: 'ladder', stageIndex: idx };
      next.dueAt = dueForStage(ladder, idx, now);
      return next;
    }
  }
}

function snapshot(card: Card): CardSnapshot {
  return {
    state: card.state,
    srs: card.srs ? structuredClone(card.srs) : null,
    ...(card.dueAt !== undefined ? { dueAt: card.dueAt } : {}),
    stats: { ...card.stats },
  };
}

/**
 * Apply one manual action to a set of cards atomically, logging each change.
 * `clearPassed` un-passes the item (a reset should genuinely undo progress);
 * gating then re-settles from the real card state.
 */
async function manualUpdate(
  cardIds: string[],
  action: ManualAction,
  now: number,
  opts: { clearPassed?: boolean } = {},
): Promise<ManualResult & { courseIds: string[] }> {
  const sessionId = newId();
  return db.transaction(
    'rw',
    [db.cards, db.items, db.courses, db.ladders, db.reviewLogs],
    async () => {
      const cards = (await db.cards.bulkGet(cardIds)).filter((c): c is Card => !!c);
      if (cards.length === 0) throw new Error('card not found');

      const ladders = new Map<string, SrsLadder>();
      const ladderFor = async (courseId: string): Promise<SrsLadder> => {
        const cached = ladders.get(courseId);
        if (cached) return cached;
        const course = await db.courses.get(courseId);
        if (!course) throw new Error('course not found');
        if (course.scheduling.kind !== 'ladder') {
          throw new Error('manual stage control needs a ladder-scheduled course');
        }
        const ladder = await db.ladders.get(course.scheduling.ladderId);
        if (!ladder) throw new Error('ladder not found');
        ladders.set(courseId, ladder);
        return ladder;
      };

      const logs: ReviewLog[] = [];
      const itemIds = new Set<string>();
      for (const card of cards) {
        const ladder = card.isGhost
          ? ((await db.ladders.get('preset-ghost')) ?? (await ladderFor(card.courseId)))
          : await ladderFor(card.courseId);
        const prev = snapshot(card);
        const updated = applyAction(card, action, ladder, now);
        await db.cards.put(updated);
        itemIds.add(card.itemId);
        logs.push({
          id: newId(),
          cardId: card.id,
          itemId: card.itemId,
          courseId: card.courseId,
          ts: now,
          sessionId,
          kind: 'manual',
          prev,
          cardMeta: {
            templateId: card.templateId,
            ...(card.isGhost ? { isGhost: true, parentCardId: card.parentCardId } : {}),
          },
        });
      }
      await db.reviewLogs.bulkAdd(logs);

      const courseIds = [...new Set(cards.map((c) => c.courseId))];
      let gating = NO_GATING;
      for (const itemId of itemIds) {
        const item = await db.items.get(itemId);
        if (!item) continue;
        if (opts.clearPassed && item.passedAt !== null) {
          await db.items.put({ ...item, passedAt: null, updatedAt: now });
          continue;
        }
        const course = await db.courses.get(item.courseId);
        // promoting a card can complete an item — unlock its dependents now
        if (course && !opts.clearPassed) {
          const outcome = await applyGatingAfterReview(course, itemId, now);
          if (outcome.itemPassed) gating = outcome;
        }
      }

      return { sessionId, cardsChanged: cards.length, gating, courseIds };
    },
  );
}

async function run(
  cardIds: string[],
  action: ManualAction,
  now: number,
  opts: { clearPassed?: boolean } = {},
): Promise<ManualResult> {
  const res = await manualUpdate(cardIds, action, now, opts);
  if (opts.clearPassed) {
    // items were un-passed: dependents may need re-locking, levels re-deriving
    for (const courseId of res.courseIds) await recomputeUnlocks(courseId, now);
  }
  return res;
}

async function realCardIdsForItem(itemId: string): Promise<string[]> {
  const cards = await db.cards.where('itemId').equals(itemId).toArray();
  return cards.filter((c) => !c.isGhost).map((c) => c.id); // ghosts are drills, not progress
}

export async function setCardManual(
  cardId: string,
  action: ManualAction,
  now: number,
): Promise<ManualResult> {
  return run([cardId], action, now, { clearPassed: action.kind === 'reset' });
}

/** Put every card of an item at the same stage (WaniKani's "set SRS level"). */
export async function setItemStage(
  itemId: string,
  stageIndex: number,
  now: number,
): Promise<ManualResult> {
  return run(await realCardIdsForItem(itemId), { kind: 'setStage', stageIndex }, now);
}

/** Send an item back to the lesson queue, wiping its scheduling and its pass. */
export async function resetItem(itemId: string, now: number): Promise<ManualResult> {
  return run(await realCardIdsForItem(itemId), { kind: 'reset' }, now, { clearPassed: true });
}

export async function suspendItem(itemId: string, now: number): Promise<ManualResult> {
  return run(await realCardIdsForItem(itemId), { kind: 'suspend' }, now);
}

export async function resumeItem(itemId: string, now: number): Promise<ManualResult> {
  return run(await realCardIdsForItem(itemId), { kind: 'resume' }, now);
}

/** The most recent manual operation on an item, for the undo button. */
export async function lastManualBatch(
  itemId: string,
): Promise<{ sessionId: string; ts: number; cards: number } | null> {
  // reviewLogs is indexed by cardId, not itemId — go through the item's cards
  const cardIds = await db.cards.where('itemId').equals(itemId).primaryKeys();
  if (cardIds.length === 0) return null;
  const logs = await db.reviewLogs.where('cardId').anyOf(cardIds).toArray();
  const manual = logs.filter((l) => l.kind === 'manual');
  if (manual.length === 0) return null;
  const latest = manual.reduce((a, b) => (b.ts >= a.ts ? b : a));
  const group = manual.filter((l) => l.sessionId === latest.sessionId);
  return { sessionId: latest.sessionId, ts: latest.ts, cards: group.length };
}

/**
 * Undo a whole manual operation: restore every card from its snapshot and drop
 * the logs. As with review undo, unlock cascades are not rewound — but the
 * recompute below re-derives `passedAt` from the restored cards, so a reset
 * that un-passed an item is fully reversed.
 */
export async function undoManualBatch(sessionId: string, now: number): Promise<number> {
  const { restored, courseIds } = await db.transaction(
    'rw',
    [db.cards, db.reviewLogs],
    async () => {
      const logs = (
        await db.reviewLogs
          .where('[sessionId+ts]')
          .between([sessionId, Dexie.minKey], [sessionId, Dexie.maxKey])
          .toArray()
      ).filter((l) => l.kind === 'manual');
      let restored = 0;
      for (const log of logs) {
        const card = await db.cards.get(log.cardId);
        if (!card) continue;
        const next: Card = {
          ...card,
          state: log.prev.state,
          srs: log.prev.srs,
          stats: { ...log.prev.stats },
          updatedAt: now,
        };
        if (log.prev.dueAt !== undefined) next.dueAt = log.prev.dueAt;
        else delete next.dueAt;
        await db.cards.put(next);
        restored++;
      }
      await db.reviewLogs.bulkDelete(logs.map((l) => l.id));
      return { restored, courseIds: [...new Set(logs.map((l) => l.courseId))] };
    },
  );
  for (const courseId of courseIds) await recomputeUnlocks(courseId, now);
  return restored;
}
