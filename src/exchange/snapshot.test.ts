import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { applyPacket } from '@/packages/importPacket';
import { parsePacket, PACKET_FORMAT, PACKET_VERSION } from '@/packages/schema';
import { buildSnapshot } from './snapshot';

const NOW = Date.UTC(2026, 8, 1, 9, 0);

interface SnapUnit {
  level: number;
  title: string;
  released: boolean;
  releaseAt: string | null;
  pendingProposals: number;
}
interface SnapCourse {
  id: string;
  currentLevel: number;
  plan: { releaseMode: string; hasMaterial: boolean; units: SnapUnit[] } | null;
  counts: { pendingProposals: number; items: number };
  items: { level: number; preview: string }[];
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await ensurePresets();
});

describe('snapshot', () => {
  it('exposes a plan’s units, release state, pending proposals, and item levels', async () => {
    const planned = await applyPacket(
      parsePacket({
        format: PACKET_FORMAT,
        version: PACKET_VERSION,
        kind: 'course-plan',
        course: { name: 'Bio', releaseMode: 'schedule' },
        itemTypes: [
          {
            name: 'Term',
            fields: [{ name: 'Term' }, { name: 'Definition' }],
            templates: [{ name: 'Define', promptFields: ['Term'], answerField: 'Definition' }],
          },
        ],
        units: [
          { title: 'Cells', items: [{ fields: { Term: 'cell', Definition: 'unit of life' } }] },
          { title: 'Genetics', releaseAt: '2026-09-15' },
        ],
        material: 'notes',
      }),
      NOW,
    );
    const plain = await applyPacket(
      parsePacket({
        format: PACKET_FORMAT,
        version: PACKET_VERSION,
        kind: 'create-course',
        course: { name: 'Plain' },
        itemTypes: [
          {
            name: 'Card',
            fields: [{ name: 'Front' }, { name: 'Back' }],
            templates: [{ name: 'Recall', promptFields: ['Front'], answerField: 'Back' }],
          },
        ],
        items: [{ fields: { Front: 'q', Back: 'a' } }],
      }),
      NOW + 1,
    );

    const snap = (await buildSnapshot(NOW + 2)) as { courses: SnapCourse[] };
    const bio = snap.courses.find((c) => c.id === planned.courseId)!;
    expect(bio.currentLevel).toBe(1);
    expect(bio.plan?.releaseMode).toBe('schedule');
    expect(bio.plan?.hasMaterial).toBe(true);
    expect(bio.plan?.units).toEqual([
      { level: 1, title: 'Cells', summary: '', topics: [], targetCount: 1, released: true, releaseAt: null, pendingProposals: 1 },
      { level: 2, title: 'Genetics', summary: '', topics: [], targetCount: 0, released: false, releaseAt: '2026-09-15', pendingProposals: 0 },
    ]);
    expect(bio.counts.pendingProposals).toBe(1);
    expect(bio.counts.items).toBe(0);

    const other = snap.courses.find((c) => c.id === plain.courseId)!;
    expect(other.plan).toBeNull();
    expect(other.counts.pendingProposals).toBe(0);
    expect(other.items[0].level).toBe(1);
  });
});
