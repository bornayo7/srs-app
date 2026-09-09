import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { Badge, Button, Field, Panel, Status, TextInput } from '@/components/ui';
import { useNowTick } from '@/hooks/useNowTick';

import { useOperation } from '@/hooks/useOperation';
import { itemPreview } from '@/engine/grading/context';
import { formatDuration } from '@/engine/time';
import type { Card, Course, Item, ItemType, SrsLadder } from '@/engine/types';
import { deleteItem } from '@/db/repo/items';

import { now } from '@/services/clock';
import { ItemEditorButton } from '@/components/editor/ItemEditor';
function stageBadge(ladder: SrsLadder | null, card: Card | undefined, t: number) {
  if (!card) return null;
  if (card.state === 'new') return <Badge>new</Badge>;
  if (card.state === 'burned') return <Badge color="amber">🔥 burned</Badge>;
  if (card.state === 'suspended') return <Badge color="amber">suspended</Badge>;
  if (!ladder || card.srs?.kind !== 'ladder') return <Badge>—</Badge>;
  const idx = card.srs.stageIndex;
  const name = idx >= ladder.stages.length ? 'Burned' : ladder.stages[idx].name;
  const color = idx >= ladder.passesAtIndex ? 'violet' : 'rose';
  const due =
    card.dueAt === undefined
      ? ''
      : card.dueAt <= t
        ? ' · due now'
        : ` · ${formatDuration(card.dueAt - t)}`;
  return <Badge color={color}>{name + due}</Badge>;
}

export function ItemsPanel({
  course,
  types,
  ladder,
}: {
  course: Course;
  types: ItemType[];
  ladder: SrsLadder | null;
}) {
  const t = useNowTick();
  const operation = useOperation();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [limit, setLimit] = useState(50);
  const items = useLiveQuery(
    () => db.items.where('courseId').equals(course.id).toArray(),
    [course.id],
  );

  const cards = useLiveQuery(async () => {
    const list = await db.cards
      .where('itemId')
      .anyOf((items ?? []).map((i) => i.id))
      .toArray();
    const byItem = new Map<string, Card[]>();
    for (const c of list) {
      const arr = byItem.get(c.itemId) ?? [];
      arr.push(c);
      byItem.set(c.itemId, arr);
    }
    return byItem;
  }, [items]);

  const typeById = new Map(types.map((ty) => [ty.id, ty]));
  const previewById = new Map(
    (items ?? []).map((i) => {
      const ty = typeById.get(i.typeId);
      return [i.id, ty ? itemPreview(i, ty) : i.id];
    }),
  );
  const passedIds = new Set((items ?? []).filter((i) => i.passedAt !== null).map((i) => i.id));
  const matching = (items ?? []).filter(
    (item) =>
      (status === 'all' || item.status === status) &&
      (!query.trim() ||
        `${previewById.get(item.id)} ${item.note} ${JSON.stringify(item.fieldValues)}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())),
  );
  const sorted = [...matching].sort((a, b) => a.level - b.level || a.createdAt - b.createdAt);
  const showLevels = course.levelMode === 'levels';

  /** Why is this item locked? Level, or which prerequisites are still pending. */
  const lockReason = (item: Item): string => {
    if (showLevels && item.level > course.currentLevel) return `Unlocks at level ${item.level}`;
    const pending = item.prereqIds
      .filter((id) => !passedIds.has(id))
      .map((id) => previewById.get(id) ?? '(deleted item)');
    return pending.length > 0
      ? `Waiting on: ${pending.join(', ')}`
      : 'Locked — run “Recheck unlocks”';
  };

  return (
    <Panel title={`Items · ${items?.length ?? 0}`}>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Search items" className="min-w-0 grow">
          <TextInput
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(50);
            }}
            placeholder="Find a word, answer or note"
          />
        </Field>
        <Field label="Status">
          <select
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setLimit(50);
            }}
          >
            <option value="all">All items</option>
            <option value="locked">Locked</option>
            <option value="lesson">Lesson queue</option>
            <option value="active">Learning</option>
          </select>
        </Field>
      </div>
      <Status {...operation} />
      {items && items.length === 0 && (
        <p className="text-sm text-slate-500">No items yet — add your first one below.</p>
      )}
      <ul className="divide-y divide-slate-800/70">
        {sorted.slice(0, limit).map((item) => {
          const ty = typeById.get(item.typeId);
          if (!ty) return null;
          const locked = item.status === 'locked';
          return (
            <li
              key={item.id}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: ty.color }}
                />
                {showLevels && (
                  <span className="shrink-0 rounded bg-slate-800 px-1.5 text-[10px] text-slate-400">
                    L{item.level}
                  </span>
                )}
                <span className="truncate text-sm text-slate-200" title={item.note || undefined}>
                  {itemPreview(item, ty)}
                  {item.note && <span className="ml-1 text-violet-300/70">💡</span>}
                </span>
                <span className="shrink-0 text-xs text-slate-500">{ty.name}</span>
                {item.passedAt !== null && (
                  <span
                    className="shrink-0 text-xs text-violet-400"
                    title="Passed — unlocks its dependents"
                  >
                    ✓
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                {locked ? (
                  <span className="text-xs text-slate-400" title={lockReason(item)}>
                    <Badge>🔒 locked</Badge>
                    <span className="ml-1">{lockReason(item)}</span>
                  </span>
                ) : item.status === 'lesson' ? (
                  <Badge color="sky">lesson queue</Badge>
                ) : (
                  (cards?.get(item.id) ?? []).map((c) =>
                    c.isGhost ? (
                      <span key={c.id} title="ghost drill pending">
                        <Badge color="sky">👻</Badge>
                      </span>
                    ) : (
                      <span key={c.id}>{stageBadge(ladder, c, t)}</span>
                    ),
                  )
                )}
                <ItemEditorButton item={item} itemType={ty} course={course} ladder={ladder} />
                <Button
                  variant="ghost"
                  aria-label={`Delete ${itemPreview(item, ty)}`}
                  disabled={operation.busy}
                  onClick={() => {
                    if (confirm('Delete this item and its history?')) {
                      void operation.run(() => deleteItem(item.id, now()), 'Item deleted.');
                    }
                  }}
                >
                  ✕
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {matching.length === 0 && !!items?.length && (
        <p role="status" className="py-4 text-sm text-slate-400">
          No items match. Try another search or status.
        </p>
      )}
      {matching.length > limit && (
        <Button className="mt-3" onClick={() => setLimit((n) => n + 50)}>
          Show more ({Math.min(limit, matching.length)} of {matching.length})
        </Button>
      )}
    </Panel>
  );
}
