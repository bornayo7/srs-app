import Dexie from 'dexie';
import { db } from '@/db/db';
import { startOfLocalDay } from '@/engine/time';
import { itemPreview } from '@/engine/grading/context';
import type { Card, Item, ItemType } from '@/engine/types';

/**
 * snapshot.json — what the app publishes into the exchange folder so MCP
 * clients (Claude, ChatGPT, Hermes) can see courses, type schemas, stats, and
 * struggling items without touching IndexedDB.
 */

const MAX_ITEMS_PER_COURSE = 1000;

export interface SnapshotItem {
  id: string;
  type: string;
  preview: string;
  fields: Record<string, string>;
  status: string;
  stageIndex: number | null;
  reviews: number;
  lapses: number;
  note?: string;
}

export async function buildSnapshot(now: number): Promise<Record<string, unknown>> {
  const courses = await db.courses.toArray();
  const out = [];

  for (const course of courses) {
    const types = await db.itemTypes.where('courseId').equals(course.id).toArray();
    const typeById = new Map<string, ItemType>(types.map((t) => [t.id, t]));
    const items = await db.items.where('courseId').equals(course.id).toArray();
    // ALL cards (burned/suspended history counts too, not just scheduled ones)
    const allCards = await db.cards
      .where('[courseId+state]')
      .between([course.id, Dexie.minKey], [course.id, Dexie.maxKey])
      .toArray();
    const reviewCards = allCards.filter((c) => c.state === 'review');
    const burned = allCards.filter((c) => c.state === 'burned').length;
    const cardsByItem = new Map<string, Card[]>();
    for (const c of allCards) {
      const arr = cardsByItem.get(c.itemId) ?? [];
      arr.push(c);
      cardsByItem.set(c.itemId, arr);
    }

    const ladder =
      course.scheduling.kind === 'ladder' ? await db.ladders.get(course.scheduling.ladderId) : null;

    const toSnapshotItem = (item: Item): SnapshotItem | null => {
      const itemType = typeById.get(item.typeId);
      if (!itemType) return null;
      const fields: Record<string, string> = {};
      for (const f of itemType.fields) {
        const v = item.fieldValues[f.id];
        const text = typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : '';
        if (text) fields[f.name] = text.slice(0, 200);
      }
      const itemCards = cardsByItem.get(item.id) ?? [];
      const stageIndex = itemCards.reduce<number | null>((min, c) => {
        if (c.state !== 'review' || c.srs?.kind !== 'ladder') return min;
        return min === null ? c.srs.stageIndex : Math.min(min, c.srs.stageIndex);
      }, null);
      return {
        id: item.id,
        type: itemType.name,
        preview: itemPreview(item, itemType).slice(0, 120),
        fields,
        status: item.status,
        stageIndex,
        reviews: itemCards.reduce((s, c) => s + c.stats.reviews, 0),
        lapses: itemCards.reduce((s, c) => s + c.stats.lapses, 0),
        ...(item.note ? { note: item.note.slice(0, 300) } : {}),
      };
    };

    // struggling computed over the FULL item set, before the size truncation
    const fullSnapshotItems = items
      .map(toSnapshotItem)
      .filter((x): x is SnapshotItem => x !== null);
    const snapshotItems = fullSnapshotItems.slice(0, MAX_ITEMS_PER_COURSE);

    const struggling = fullSnapshotItems
      .filter((i) => i.lapses >= 2)
      .sort((a, b) => b.lapses - a.lapses)
      .slice(0, 15);

    out.push({
      id: course.id,
      name: course.name,
      description: course.description,
      scheduling: course.scheduling.kind,
      ladder: ladder
        ? {
            name: ladder.name,
            stages: ladder.stages.map((s) => s.name),
            passesAtIndex: ladder.passesAtIndex,
          }
        : null,
      lessons: course.lessons,
      itemTypes: types.map((t) => ({
        name: t.name,
        icon: t.icon,
        fields: t.fields.map((f) => ({ name: f.name, kind: f.kind })),
        templates: t.templates.map((tpl) => ({
          name: tpl.name,
          promptFields: tpl.promptFieldIds.map(
            (id) => t.fields.find((f) => f.id === id)?.name ?? id,
          ),
          answerField: t.fields.find((f) => f.id === tpl.answerFieldId)?.name ?? tpl.answerFieldId,
        })),
      })),
      counts: {
        items: items.length,
        lessonQueue: items.filter((i) => i.status === 'lesson').length,
        active: items.filter((i) => i.status === 'active').length,
        dueNow: reviewCards.filter((c) => c.dueAt !== undefined && c.dueAt <= now).length,
        burnedCards: burned,
      },
      items: snapshotItems,
      struggling,
      itemsTruncated: items.length > MAX_ITEMS_PER_COURSE,
    });
  }

  return {
    format: 'srs-snapshot',
    version: 1,
    generatedAt: now,
    localDay: startOfLocalDay(now),
    courses: out,
  };
}
