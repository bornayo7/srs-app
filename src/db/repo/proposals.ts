import { db } from '../db';
import { newId } from '@/engine/ids';
import type {
  Item,
  ItemType,
  Proposal,
  ProposalItem,
  ProposalSource,
  ProposalStatus,
} from '@/engine/types';

/** One proposal-to-be: the item plus what the dry-run found out about it. */
export interface ProposalDraft {
  level: number;
  item: ProposalItem;
  error: string | null;
  duplicateOf: string | null;
}

/**
 * Persist drafts as pending proposals. Validation and duplicate detection are
 * the caller's job (importPacket owns type resolution) — this layer only
 * writes rows, with strictly increasing timestamps so the review queue keeps
 * the authored order.
 */
export async function addProposals(
  courseId: string,
  planId: string | null,
  source: ProposalSource,
  drafts: ProposalDraft[],
  now: number,
): Promise<Proposal[]> {
  let stamp = now;
  const rows: Proposal[] = drafts.map((d) => ({
    id: newId(),
    courseId,
    planId,
    level: d.level,
    item: d.item,
    source,
    status: 'pending',
    error: d.error,
    duplicateOf: d.duplicateOf,
    rejectReason: null,
    acceptedItemId: null,
    createdAt: stamp++,
    decidedAt: null,
    updatedAt: now,
  }));
  await db.proposals.bulkAdd(rows);
  return rows;
}

/** Proposals for a course, unit order then authored order. */
export async function proposalsForCourse(
  courseId: string,
  status?: ProposalStatus,
): Promise<Proposal[]> {
  const rows = status
    ? await db.proposals.where('[courseId+status]').equals([courseId, status]).toArray()
    : await db.proposals.where('courseId').equals(courseId).toArray();
  return rows.sort((a, b) => a.level - b.level || a.createdAt - b.createdAt);
}

export async function pendingCount(courseId: string): Promise<number> {
  return db.proposals.where('[courseId+status]').equals([courseId, 'pending']).count();
}

function textKey(v: unknown): string | null {
  if (typeof v === 'string') return v.trim().toLowerCase() || null;
  if (Array.isArray(v) && typeof v[0] === 'string') {
    return (v[0] as string).trim().toLowerCase() || null;
  }
  return null;
}

/**
 * Does this proposal look like an existing item of the same type? Compares
 * the first text field (the one item lists preview by), case-insensitively.
 * A flag for the reviewer, never a block — near-duplicates are sometimes
 * deliberate.
 */
export function findDuplicate(
  item: ProposalItem,
  itemType: ItemType,
  existing: readonly Item[],
): string | null {
  const firstField = itemType.fields.find((f) => f.kind !== 'image' && f.kind !== 'audio');
  if (!firstField) return null;
  const byName = new Map(Object.entries(item.fields).map(([k, v]) => [k.toLowerCase(), v]));
  const key = textKey(byName.get(firstField.name.toLowerCase()));
  if (!key) return null;
  for (const it of existing) {
    if (it.typeId !== itemType.id) continue;
    if (textKey(it.fieldValues[firstField.id]) === key) return it.id;
  }
  return null;
}
