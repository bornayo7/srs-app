import type { ItemStatus } from './types';

/**
 * Prerequisite gating — WaniKani's radical→kanji→vocab machinery, generalized.
 * Pure functions over a minimal item shape so they're trivially testable; the
 * DB side (services/gating.ts) supplies the rows and writes the results.
 *
 * Two independent conditions unlock an item:
 *   1. its level has been reached by the course
 *   2. every prerequisite item has PASSED (reached the ladder's pass stage)
 */

export interface GateItem {
  id: string;
  level: number;
  prereqIds: string[];
  status: ItemStatus;
  passedAt: number | null;
}

export function isPassed(item: Pick<GateItem, 'passedAt'>): boolean {
  return item.passedAt !== null;
}

/** Does this item satisfy both unlock conditions right now? */
export function meetsUnlockConditions(
  item: GateItem,
  passedIds: ReadonlySet<string>,
  currentLevel: number,
): boolean {
  if (item.level > currentLevel) return false;
  return item.prereqIds.every((id) => passedIds.has(id));
}

/**
 * Desired status for every item, given what has passed and the course level.
 * - 'active' is never demoted: real SRS progress outranks any later edit.
 * - 'lesson' ⇄ 'locked' both directions, so editing prereqs/levels self-heals.
 */
export function computeStatuses(
  items: readonly GateItem[],
  currentLevel: number,
): Map<string, ItemStatus> {
  const passedIds = new Set(items.filter(isPassed).map((i) => i.id));
  const out = new Map<string, ItemStatus>();
  for (const item of items) {
    if (item.status === 'active') {
      out.set(item.id, 'active');
      continue;
    }
    out.set(item.id, meetsUnlockConditions(item, passedIds, currentLevel) ? 'lesson' : 'locked');
  }
  return out;
}

/** Items whose status must change (excludes no-ops). */
export function statusChanges(
  items: readonly GateItem[],
  currentLevel: number,
): { id: string; from: ItemStatus; to: ItemStatus }[] {
  const desired = computeStatuses(items, currentLevel);
  const changes: { id: string; from: ItemStatus; to: ItemStatus }[] = [];
  for (const item of items) {
    const to = desired.get(item.id)!;
    if (to !== item.status) changes.push({ id: item.id, from: item.status, to });
  }
  return changes;
}

/** Status a brand-new item should start in. */
export function initialStatusFor(
  level: number,
  prereqIds: readonly string[],
  currentLevel: number,
  prereqsAllPassed: boolean,
): ItemStatus {
  if (level > currentLevel) return 'locked';
  return prereqIds.length === 0 || prereqsAllPassed ? 'lesson' : 'locked';
}

/**
 * Would adding these prereqs to `itemId` create a cycle? Items can't gate
 * themselves, directly or transitively — a cycle would lock both forever.
 */
export function wouldCycle(
  items: readonly GateItem[],
  itemId: string,
  newPrereqIds: readonly string[],
): boolean {
  if (newPrereqIds.includes(itemId)) return true;
  const byId = new Map(items.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const stack = [...newPrereqIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === itemId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const item = byId.get(id);
    if (item) stack.push(...item.prereqIds);
  }
  return false;
}
