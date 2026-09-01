import { db } from '@/db/db';
import { createItem } from '@/db/repo/items';
import { dryRunProposal, resolvePacketItem } from '@/packages/importPacket';
import type { Proposal, ProposalItem } from '@/engine/types';

/**
 * The review queue's verbs. A proposal is an AI/MCP-drafted item waiting for a
 * human; nothing here touches an item the learner already owns, and nothing
 * here is an SRS event.
 */

export interface AcceptResult {
  /** Proposal ids that became items, in the order they were created. */
  accepted: string[];
  itemIds: string[];
  /** Proposals left pending; the reason is also written onto the row. */
  skipped: { id: string; reason: string }[];
  warnings: string[];
}

function label(p: Proposal): string {
  for (const v of Object.values(p.item.fields)) {
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 40);
  }
  return '(item)';
}

/**
 * Accept pending proposals: each becomes a real item at its unit's level —
 * locked if that unit hasn't been released, otherwise straight into the
 * lesson queue. Prerequisite handles resolve to accepted items (from earlier
 * batches or this one, in any order); one that points at a still-pending
 * proposal holds the item back with a message, and one that points at a
 * rejected or unknown handle is dropped with a warning. Rows that fail
 * validation are skipped with the error written onto them, never thrown.
 */
export async function acceptProposals(ids: string[], now: number): Promise<AcceptResult> {
  return db.transaction(
    'rw',
    [db.courses, db.itemTypes, db.items, db.cards, db.proposals],
    async () => {
      const result: AcceptResult = { accepted: [], itemIds: [], skipped: [], warnings: [] };
      const rows = (await db.proposals.bulkGet(ids)).filter(
        (p): p is Proposal => !!p && p.status === 'pending',
      );
      if (rows.length === 0) return result;
      const courseId = rows[0].courseId;
      if (rows.some((p) => p.courseId !== courseId)) {
        throw new Error('proposals span more than one course');
      }
      const course = await db.courses.get(courseId);
      if (!course) throw new Error(`course not found: ${courseId}`);
      const types = await db.itemTypes.where('courseId').equals(courseId).toArray();

      // handle → item id for everything already accepted; handle → proposal
      // id for what's still pending (so a same-batch dependency can wait)
      const keyToItem = new Map<string, string>();
      const pendingKeys = new Map<string, string>();
      for (const p of await db.proposals.where('courseId').equals(courseId).toArray()) {
        if (!p.item.key) continue;
        if (p.status === 'accepted' && p.acceptedItemId) keyToItem.set(p.item.key, p.acceptedItemId);
        else if (p.status === 'pending') pendingKeys.set(p.item.key, p.id);
      }
      const existingIds = new Set(await db.items.where('courseId').equals(courseId).primaryKeys());
      const batchIds = new Set(rows.map((r) => r.id));

      const skip = async (p: Proposal, reason: string) => {
        await db.proposals.put({ ...p, error: reason, updatedAt: now });
        result.skipped.push({ id: p.id, reason });
      };

      let stamp = now;
      // authored order first; a dependency accepted later in the same batch
      // is picked up by the retry passes
      let queue = [...rows].sort((a, b) => a.createdAt - b.createdAt);
      for (let pass = 0; queue.length > 0 && pass <= rows.length; pass++) {
        const deferred: Proposal[] = [];
        let progressed = false;
        for (const p of queue) {
          let resolved: ReturnType<typeof resolvePacketItem>;
          try {
            resolved = resolvePacketItem(p.item, types);
          } catch (err) {
            await skip(p, (err as Error).message.replace(/^Item \d+: /, ''));
            continue;
          }

          const prereqIds: string[] = [];
          let waitFor: string | null = null;
          let hold: string | null = null;
          for (const ref of p.item.prereqs ?? []) {
            const viaKey = keyToItem.get(ref);
            if (viaKey) {
              prereqIds.push(viaKey);
            } else if (existingIds.has(ref)) {
              prereqIds.push(ref);
            } else if (pendingKeys.has(ref)) {
              if (batchIds.has(pendingKeys.get(ref)!)) waitFor = ref; // later in this batch
              else hold = `prerequisite "${ref}" hasn't been accepted yet — accept it first, or remove the prerequisite`;
              break;
            } else {
              result.warnings.push(
                `${label(p)}: dropped prerequisite "${ref}" (rejected or unknown).`,
              );
            }
          }
          if (hold) {
            await skip(p, hold);
            continue;
          }
          if (waitFor) {
            deferred.push(p);
            continue;
          }

          const created = await createItem(
            {
              courseId,
              typeId: resolved.itemType.id,
              ...resolved.resolved,
              level: p.level,
              prereqIds: [...new Set(prereqIds)],
            },
            stamp++,
          );
          if (p.item.key) {
            keyToItem.set(p.item.key, created.id);
            pendingKeys.delete(p.item.key);
          }
          existingIds.add(created.id);
          await db.proposals.put({
            ...p,
            status: 'accepted',
            acceptedItemId: created.id,
            error: null,
            decidedAt: now,
            updatedAt: now,
          });
          result.accepted.push(p.id);
          result.itemIds.push(created.id);
          progressed = true;
        }
        queue = deferred;
        if (!progressed) break;
      }
      // whatever is still deferred depends on something that never landed
      for (const p of queue) {
        const ref = (p.item.prereqs ?? []).find((r) => pendingKeys.has(r)) ?? '?';
        await skip(
          p,
          `prerequisite "${ref}" hasn't been accepted yet — accept it first, or remove the prerequisite`,
        );
      }
      return result;
    },
  );
}

/** Every pending proposal of a course (optionally one unit) that passed its dry-run. */
export async function acceptAllValid(
  courseId: string,
  now: number,
  level?: number,
): Promise<AcceptResult> {
  const pending = await db.proposals.where('[courseId+status]').equals([courseId, 'pending']).toArray();
  const ids = pending
    .filter((p) => p.error === null && (level === undefined || p.level === level))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((p) => p.id);
  return acceptProposals(ids, now);
}

export async function rejectProposals(ids: string[], reason: string, now: number): Promise<number> {
  return db.transaction('rw', db.proposals, async () => {
    let n = 0;
    for (const p of await db.proposals.bulkGet(ids)) {
      if (!p || p.status !== 'pending') continue;
      await db.proposals.put({
        ...p,
        status: 'rejected',
        rejectReason: reason.trim() || null,
        decidedAt: now,
        updatedAt: now,
      });
      n++;
    }
    return n;
  });
}

/** Re-run the dry-run for a row against the course's current types and items. */
async function rechecked(p: Proposal): Promise<Proposal> {
  const types = await db.itemTypes.where('courseId').equals(p.courseId).toArray();
  const existing = await db.items.where('courseId').equals(p.courseId).toArray();
  return { ...p, ...dryRunProposal(p.item, types, existing) };
}

/** Rejected → pending, with the checks refreshed (types may have changed since). */
export async function restoreProposals(ids: string[], now: number): Promise<number> {
  return db.transaction('rw', [db.proposals, db.itemTypes, db.items], async () => {
    let n = 0;
    for (const p of await db.proposals.bulkGet(ids)) {
      if (!p || p.status !== 'rejected') continue;
      await db.proposals.put({
        ...(await rechecked(p)),
        status: 'pending',
        rejectReason: null,
        decidedAt: null,
        updatedAt: now,
      });
      n++;
    }
    return n;
  });
}

/**
 * Edit a proposal before accepting it. Works on pending and rejected rows
 * (an edited rejected row comes back as pending); accepted rows are history
 * — edit the item instead.
 */
export async function updateProposalItem(
  id: string,
  item: ProposalItem,
  now: number,
): Promise<Proposal> {
  return db.transaction('rw', [db.proposals, db.itemTypes, db.items], async () => {
    const p = await db.proposals.get(id);
    if (!p) throw new Error('proposal not found');
    if (p.status === 'accepted') throw new Error('already accepted — edit the item instead');
    const next = await rechecked({ ...p, item: { ...item, level: p.level } });
    const saved: Proposal = {
      ...next,
      status: 'pending',
      rejectReason: null,
      decidedAt: null,
      updatedAt: now,
    };
    await db.proposals.put(saved);
    return saved;
  });
}

/** Refresh every pending row's checks — after an item-type edit, for example. */
export async function recheckPending(courseId: string, now: number): Promise<number> {
  return db.transaction('rw', [db.proposals, db.itemTypes, db.items], async () => {
    const pending = await db.proposals.where('[courseId+status]').equals([courseId, 'pending']).toArray();
    let changed = 0;
    for (const p of pending) {
      const next = await rechecked(p);
      if (next.error !== p.error || next.duplicateOf !== p.duplicateOf) {
        await db.proposals.put({ ...next, updatedAt: now });
        changed++;
      }
    }
    return changed;
  });
}

/** Remove rows for good (accepted rows keep their items — this only drops the record). */
export async function deleteProposals(ids: string[]): Promise<void> {
  await db.proposals.bulkDelete(ids);
}
