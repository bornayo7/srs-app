import { db } from '@/db/db';
import type { Card, Course, Item, ItemStatus } from '@/engine/types';
import type { Scheduler } from '@/engine/scheduler/types';
import { computeStatuses, statusChanges, wouldCycle, type GateItem } from '@/engine/gating';
import { studyStatus } from '@/engine/typeDesign';
import { DEFAULT_PASS_PERCENT, levelProgress, shouldLevelUp } from '@/engine/levels';
import { schedulerForCourse } from './schedulers';

/**
 * Gating + levels against the database. Everything here runs INSIDE the
 * caller's transaction (commitReview's, or its own for repairs) so a cascade
 * either lands completely or not at all.
 *
 * Cost note: passing an item costs O(direct dependents), not O(graph) — the
 * reverse lookup uses the multiEntry `*prereqIds` index.
 */

export interface GatingOutcome {
  itemPassed: boolean;
  unlockedItemIds: string[];
  leveledUpTo: number | null;
}

const NO_CHANGE: GatingOutcome = { itemPassed: false, unlockedItemIds: [], leveledUpTo: null };

function toGateItem(item: Item): GateItem {
  return {
    id: item.id,
    level: item.level,
    prereqIds: item.prereqIds,
    status: item.status,
    passedAt: item.passedAt,
  };
}

/** A card counts as passed when burned, or at/above the ladder's pass stage. */
function cardPassed(card: Card, scheduler: Scheduler): boolean {
  if (card.state === 'burned') return true;
  if (card.state !== 'review' || card.srs === null) return false;
  return scheduler.isPassed(card.srs);
}

/** An item passes only when ALL of its real (non-ghost) cards have passed. */
export async function itemHasPassed(itemId: string, scheduler: Scheduler): Promise<boolean> {
  const cards = (await db.cards.where('itemId').equals(itemId).toArray()).filter((c) => !c.isGhost);
  if (cards.length === 0) return false;
  return cards.every((c) => cardPassed(c, scheduler));
}

/**
 * Level ceiling to gate against. A 'flat' course has no level-up path at all,
 * so its items must NEVER be held back by their level number — otherwise a
 * stray `level: 2` (or switching a levelled course to flat) locks them forever.
 */
function gateLevel(course: Course): number {
  return course.levelMode === 'levels' ? course.currentLevel : Number.MAX_SAFE_INTEGER;
}

function gateTypeFilter(course: Course): (item: Item) => boolean {
  const ids = course.levelConfig?.gateTypeIds ?? [];
  if (ids.length === 0) return () => true; // no explicit gate types → every type counts
  return (item) => ids.includes(item.typeId);
}

async function unlockNewlyEligible(
  course: Course,
  now: number,
  candidates: Item[],
  passedIds: Set<string>,
): Promise<string[]> {
  const unlocked: string[] = [];
  const ceiling = gateLevel(course);
  for (const dep of candidates) {
    if (dep.status !== 'locked') continue;
    if (dep.courseId !== course.id) continue; // never touch another course's items
    if (dep.level > ceiling) continue;
    if (!dep.prereqIds.every((id) => passedIds.has(id))) continue;
    await db.items.put({ ...dep, status: 'lesson', unlockedAt: now, updatedAt: now });
    unlocked.push(dep.id);
  }
  return unlocked;
}

/**
 * Called from commitReview after the card is written: detect an item passing,
 * then cascade — unlock dependents, and level up when enough gate items pass.
 */
export async function applyGatingAfterReview(
  course: Course,
  itemId: string,
  now: number,
): Promise<GatingOutcome> {
  const item = await db.items.get(itemId);
  if (!item || item.passedAt !== null) return NO_CHANGE; // passedAt is sticky

  const { scheduler } = await schedulerForCourse(course);
  if (!(await itemHasPassed(itemId, scheduler))) return NO_CHANGE;

  await db.items.put({ ...item, passedAt: now, updatedAt: now });

  // passed ids for this course — small enough to hold, and needed for both
  // the dependent check and the level tally
  const courseItems = await db.items.where('courseId').equals(course.id).toArray();
  const passedIds = new Set(
    courseItems.filter((i) => i.passedAt !== null || i.id === itemId).map((i) => i.id),
  );

  // direct dependents via the multiEntry reverse index
  const dependents = await db.items.where('prereqIds').equals(itemId).toArray();
  const unlockedItemIds = await unlockNewlyEligible(course, now, dependents, passedIds);

  let leveledUpTo: number | null = null;
  if (course.levelMode === 'levels') {
    const isGate = gateTypeFilter(course);
    const passPercent = course.levelConfig?.passPercent ?? DEFAULT_PASS_PERCENT;
    let working = { ...course };
    // a level-up can immediately satisfy the next level (already-passed items)
    for (let guard = 0; guard < 50; guard++) {
      const gateItems = courseItems.filter((i) => i.level === working.currentLevel && isGate(i));
      const passedGate = gateItems.filter((i) => passedIds.has(i.id)).length;
      if (!shouldLevelUp(passedGate, gateItems.length, passPercent)) break;

      working = { ...working, currentLevel: working.currentLevel + 1, updatedAt: now };
      leveledUpTo = working.currentLevel;
      const nextLevelItems = courseItems.filter((i) => i.level === working.currentLevel);
      unlockedItemIds.push(...(await unlockNewlyEligible(working, now, nextLevelItems, passedIds)));
    }
    if (leveledUpTo !== null) await db.courses.put(working);
  }

  return { itemPassed: true, unlockedItemIds, leveledUpTo };
}

/**
 * Full recompute for a course — the repair path after imports, prereq/level
 * edits, or item deletion. Also refreshes passedAt from actual card state.
 */
export async function recomputeUnlocks(
  courseId: string,
  now: number,
): Promise<{ changed: number }> {
  return db.transaction('rw', [db.items, db.cards, db.courses, db.ladders], async () => {
    const course = await db.courses.get(courseId);
    if (!course) throw new Error(`course not found: ${courseId}`);
    const { scheduler } = await schedulerForCourse(course);
    const items = await db.items.where('courseId').equals(courseId).toArray();
    const itemIds = new Set(items.map((i) => i.id));

    // Pass 1 — drop edges that can never be satisfied: references to deleted
    // items, self-references, and any edge that closes a cycle (corrupt data;
    // both directions go, since either alone would still be arbitrary).
    const cleanedPrereqs = new Map<string, string[]>(
      items.map((i) => [i.id, i.prereqIds.filter((id) => itemIds.has(id) && id !== i.id)]),
    );
    const gateView = (): GateItem[] =>
      items.map((i) => ({ ...toGateItem(i), prereqIds: cleanedPrereqs.get(i.id) ?? [] }));
    for (const item of items) {
      const kept = (cleanedPrereqs.get(item.id) ?? []).filter((id) => {
        const others = gateView().filter((g) => g.id !== item.id);
        return !wouldCycle(others, item.id, [id]);
      });
      cleanedPrereqs.set(item.id, kept);
    }

    let changed = 0;
    const refreshed: Item[] = [];
    for (const item of items) {
      const prereqIds = cleanedPrereqs.get(item.id) ?? [];
      // passedAt is sticky once set; otherwise derive it from the cards
      const passedAt =
        item.passedAt ?? ((await itemHasPassed(item.id, scheduler)) ? now : null);
      const next = { ...item, prereqIds, passedAt };
      if (
        next.prereqIds.length !== item.prereqIds.length ||
        next.passedAt !== item.passedAt
      ) {
        changed++;
      }
      refreshed.push(next);
    }

    // Pass 2 — a config or prereq edit can retroactively satisfy the level
    // threshold (e.g. narrowing gate types), so re-run the level cascade here;
    // applyGatingAfterReview can't help because those items already passed.
    let currentLevel = course.currentLevel;
    if (course.levelMode === 'levels') {
      const isGate = gateTypeFilter(course);
      const passPercent = course.levelConfig?.passPercent ?? DEFAULT_PASS_PERCENT;
      const passedIds = new Set(refreshed.filter((i) => i.passedAt !== null).map((i) => i.id));
      for (let guard = 0; guard < 50; guard++) {
        const gate = refreshed.filter((i) => i.level === currentLevel && isGate(i));
        const passed = gate.filter((i) => passedIds.has(i.id)).length;
        if (!shouldLevelUp(passed, gate.length, passPercent)) break;
        currentLevel++;
      }
      if (currentLevel !== course.currentLevel) {
        await db.courses.put({ ...course, currentLevel, updatedAt: now });
        changed++;
      }
    }

    const changes = statusChanges(
      refreshed.map(toGateItem),
      gateLevel({ ...course, currentLevel }),
    );
    const statusById = new Map(changes.map((c) => [c.id, c.to]));

    // lesson-vs-active is card-derived, and gating can't see cards: an item
    // sitting in the lesson queue with nothing new left to teach (or an active
    // item holding an untaught card) is repaired here too.
    const allCards = await db.cards.where('itemId').anyOf(refreshed.map((i) => i.id)).toArray();
    const cardsByItem = new Map<string, Card[]>();
    for (const c of allCards) {
      if (c.isGhost) continue; // drills never define an item's lifecycle
      const arr = cardsByItem.get(c.itemId) ?? [];
      arr.push(c);
      cardsByItem.set(c.itemId, arr);
    }

    for (const item of refreshed) {
      const gated: ItemStatus = statusById.get(item.id) ?? item.status;
      const status = studyStatus(gated, cardsByItem.get(item.id) ?? []);
      const updated = {
        ...item,
        status,
        ...(status !== item.status
          ? { unlockedAt: status === 'locked' ? null : (item.unlockedAt ?? now) }
          : {}),
        updatedAt: now,
      };
      if (status !== item.status && !statusById.has(item.id)) changed++;
      await db.items.put(updated);
    }
    return { changed: changed + changes.length };
  });
}

const BACKFILL_KEY = 'migration:gating-passedAt';

/**
 * One-time backfill for courses that existed before gating shipped: their
 * items have never had `passedAt` set, so anything already learned would look
 * un-passed and hold its dependents locked. recomputeUnlocks derives it from
 * the actual card state, so just run it once per course.
 */
export async function backfillGatingOnce(now: number): Promise<void> {
  if (await db.meta.get(BACKFILL_KEY)) return;
  const courses = await db.courses.toArray();
  for (const course of courses) {
    try {
      await recomputeUnlocks(course.id, now);
    } catch {
      // a single broken course must not block startup
    }
  }
  await db.meta.put({ key: BACKFILL_KEY, value: now });
}

/** Level progress for the course header / dashboard. */
export async function courseLevelProgress(courseId: string) {
  const course = await db.courses.get(courseId);
  if (!course || course.levelMode !== 'levels') return null;
  const items = await db.items.where('[courseId+level]').equals([courseId, course.currentLevel]).toArray();
  const isGate = gateTypeFilter(course);
  const gateItems = items.filter(isGate);
  return levelProgress(
    course.currentLevel,
    gateItems.length,
    gateItems.filter((i) => i.passedAt !== null).length,
    course.levelConfig?.passPercent ?? DEFAULT_PASS_PERCENT,
  );
}

/** Locked/lesson/active/passed tallies for the course page. */
export async function courseGatingSummary(courseId: string) {
  const items = await db.items.where('courseId').equals(courseId).toArray();
  const desired = computeStatuses(items.map(toGateItem), Number.MAX_SAFE_INTEGER);
  return {
    total: items.length,
    locked: items.filter((i) => i.status === 'locked').length,
    lesson: items.filter((i) => i.status === 'lesson').length,
    active: items.filter((i) => i.status === 'active').length,
    passed: items.filter((i) => i.passedAt !== null).length,
    // locked purely by level (prereqs already satisfied) — useful "next up" hint
    levelGatedOnly: items.filter((i) => i.status === 'locked' && desired.get(i.id) === 'lesson')
      .length,
  };
}
