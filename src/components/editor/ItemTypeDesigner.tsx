import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { Badge, Button, Panel } from '@/components/ui';
import type { Course, ItemType } from '@/engine/types';
import { makeBlankItemType } from '@/services/itemTypes';
import { now } from '@/services/clock';
import { TypeDesignerModal } from './TypeDesignerModal';

/**
 * The item-type designer: fields and card templates for a course's content
 * model. Saving migrates every existing item of the type, so the impact is
 * spelled out before the user commits.
 */
export function ItemTypeDesigner({ course, types }: { course: Course; types: ItemType[] }) {
  const [editing, setEditing] = useState<ItemType | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const counts = useLiveQuery(async () => {
    const entries = await Promise.all(
      types.map(async (t) => [t.id, await db.items.where('typeId').equals(t.id).count()] as const),
    );
    return new Map(entries);
  }, [types.map((t) => t.id).join()]);

  return (
    <Panel
      title="Item types"
      actions={
        <Button
          onClick={async () => {
            setError('');
            try {
              setCreating(true);
              setEditing(makeBlankItemType(course.id, now()));
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          + New type
        </Button>
      }
    >
      {error && <p className="mb-2 text-sm text-rose-300">{error}</p>}
      <ul className="divide-y divide-slate-800/70">
        {types.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded"
                style={{ backgroundColor: t.color }}
              >
                {t.icon}
              </span>
              <span className="truncate text-sm text-slate-200">{t.name}</span>
              <span className="shrink-0 text-xs text-slate-500">
                {t.fields.length} field{t.fields.length === 1 ? '' : 's'} ·{' '}
                {t.templates.map((tpl) => tpl.name).join(' + ')}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge>{counts?.get(t.id) ?? 0} items</Badge>
              <Button
                onClick={() => {
                  setCreating(false);
                  setEditing(t);
                }}
              >
                Design
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-slate-500">
        Fields hold content; each template turns fields into one review card (WaniKani's separate
        meaning and reading cards are two templates on one type).
      </p>
      {editing && (
        <TypeDesignerModal
          key={editing.id}
          original={editing}
          creating={creating}
          itemCount={counts?.get(editing.id) ?? 0}
          canDelete={types.length > 1 && types.some((t) => t.id === editing.id)}
          onClose={() => setEditing(null)}
        />
      )}
    </Panel>
  );
}
