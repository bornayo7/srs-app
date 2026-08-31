import { beforeEach, describe, expect, it } from 'vitest';
import { db, ensurePresets } from '@/db/db';
import { parsePacket, PACKET_FORMAT, PACKET_VERSION } from './schema';
import { applyPacket } from './importPacket';
import { exportCoursePackage } from './exportPackage';
import { installSeed } from '@/db/seed';
import { techSeed } from '@/db/seed/tech';

const NOW = Date.UTC(2026, 0, 20, 9, 0);

const validCreate = {
  format: PACKET_FORMAT,
  version: PACKET_VERSION,
  kind: 'create-course',
  course: { name: 'Spanish Kitchen', ladderPreset: 'classic' },
  itemTypes: [
    {
      name: 'Word',
      icon: '🍳',
      fields: [{ name: 'Spanish' }, { name: 'English' }],
      templates: [
        { name: 'Meaning', promptFields: ['Spanish'], answerField: 'English' },
        { name: 'Production', promptFields: ['English'], answerField: 'Spanish' },
      ],
    },
  ],
  items: [
    {
      fields: { Spanish: 'la sartén', English: 'frying pan' },
      synonyms: { Meaning: ['pan'] },
      note: 'sizzle!',
    },
    { fields: { Spanish: 'el horno', English: 'oven' } },
  ],
};

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await ensurePresets();
});

describe('packet schema', () => {
  it('accepts a valid create-course packet', () => {
    expect(parsePacket(validCreate).kind).toBe('create-course');
  });

  it('rejects garbage with a readable message', () => {
    expect(() => parsePacket({ hello: 'world' })).toThrow(/Not a valid srs-packet/);
    expect(() => parsePacket({ ...validCreate, version: 2 })).toThrow(/version/);
  });

  it('rejects add-items with empty items', () => {
    expect(() =>
      parsePacket({ format: PACKET_FORMAT, version: 1, kind: 'add-items', courseId: 'x', items: [] }),
    ).toThrow();
  });
});

describe('applyPacket create-course', () => {
  it('creates course, types with both templates, and record-form synonyms on their template only', async () => {
    const res = await applyPacket(parsePacket(validCreate), NOW);
    expect(res.itemsAdded).toBe(2);

    const course = (await db.courses.get(res.courseId))!;
    expect(course.name).toBe('Spanish Kitchen');
    const types = await db.itemTypes.where('courseId').equals(res.courseId).toArray();
    expect(types).toHaveLength(1);
    expect(types[0].templates).toHaveLength(2);

    const items = await db.items.where('courseId').equals(res.courseId).toArray();
    expect(items).toHaveLength(2);
    const sarten = items.find((i) => Object.values(i.fieldValues).includes('la sartén'))!;
    // record-form synonyms attach only to the named template
    const meaningTpl = types[0].templates.find((t) => t.name === 'Meaning')!;
    expect(Object.keys(sarten.synonyms)).toEqual([meaningTpl.id]);
    expect(sarten.note).toBe('sizzle!');
    // two cards per item (two templates)
    expect(await db.cards.where('itemId').equals(sarten.id).count()).toBe(2);
  });

  it('rejects array-form synonyms on a multi-template type', async () => {
    const bad = structuredClone(validCreate);
    bad.items[0].synonyms = ['pan'] as never;
    await expect(applyPacket(parsePacket(bad), NOW)).rejects.toThrow(/record form of synonyms/);
    expect(await db.courses.count()).toBe(0);
  });

  it('rejects duplicate field/template/type names (case-insensitive)', () => {
    const dupField = structuredClone(validCreate);
    dupField.itemTypes[0].fields.push({ name: 'spanish' });
    expect(() => parsePacket(dupField)).toThrow(/duplicate field name/);

    const dupTpl = structuredClone(validCreate);
    dupTpl.itemTypes[0].templates.push({ ...dupTpl.itemTypes[0].templates[0], name: 'meaning' });
    expect(() => parsePacket(dupTpl)).toThrow(/duplicate template name/);
  });

  it('rejects [""] as an answer value', async () => {
    const bad = structuredClone(validCreate) as unknown as { items: unknown[] };
    bad.items = [{ fields: { Spanish: 'el vaso', English: [''] } }];
    await expect(applyPacket(parsePacket(bad), NOW)).rejects.toThrow(/missing answer field/);
  });

  it('resolves template field references case-insensitively', async () => {
    const pkt = structuredClone(validCreate);
    pkt.itemTypes[0].templates[0].answerField = 'ENGLISH';
    const res = await applyPacket(parsePacket(pkt), NOW);
    expect(res.itemsAdded).toBe(2);
  });

  it('auto-suffixes colliding course names and reports a warning', async () => {
    await applyPacket(parsePacket(validCreate), NOW);
    const res = await applyPacket(parsePacket(validCreate), NOW + 1000);
    expect(res.courseName).toBe('Spanish Kitchen (2)');
    expect(res.warnings[0]).toMatch(/already exists/);
  });

  it('is atomic: a bad item rolls back the whole packet', async () => {
    const bad = structuredClone(validCreate);
    bad.items.push({ fields: { Nope: 'x' } } as never);
    await expect(applyPacket(parsePacket(bad), NOW)).rejects.toThrow(/unknown field "Nope"/);
    expect(await db.courses.count()).toBe(0);
    expect(await db.items.count()).toBe(0);
  });

  it('rejects a template referencing a missing field', async () => {
    const bad = structuredClone(validCreate);
    bad.itemTypes[0].templates[0].answerField = 'Missing';
    await expect(applyPacket(parsePacket(bad), NOW)).rejects.toThrow(/unknown field "Missing"/);
    expect(await db.courses.count()).toBe(0);
  });

  it('rejects items missing an answer value', async () => {
    const bad = structuredClone(validCreate) as Record<string, unknown>;
    // no English → the Meaning template has no answer
    bad.items = [{ fields: { Spanish: 'el plato' } }];
    await expect(applyPacket(parsePacket(bad), NOW)).rejects.toThrow(/missing answer field/);
  });
});

describe('applyPacket add-items', () => {
  it('adds items to an existing course by name, case-insensitively', async () => {
    await installSeed(techSeed, NOW);
    const res = await applyPacket(
      parsePacket({
        format: PACKET_FORMAT,
        version: 1,
        kind: 'add-items',
        courseName: 'cs terms',
        items: [{ fields: { Definition: 'Immutable append-only log', Term: 'ledger' } }],
      }),
      NOW + 1000,
    );
    expect(res.itemsAdded).toBe(1);
    const items = await db.items.where('courseId').equals(res.courseId).toArray();
    expect(items.some((i) => Object.values(i.fieldValues).includes('ledger'))).toBe(true);
  });

  it('fails cleanly when the course does not exist', async () => {
    await expect(
      applyPacket(
        parsePacket({
          format: PACKET_FORMAT,
          version: 1,
          kind: 'add-items',
          courseName: 'nope',
          items: [{ fields: { A: 'b' } }],
        }),
        NOW,
      ),
    ).rejects.toThrow(/Course not found/);
  });
});

describe('export → import round trip', () => {
  it('re-importing an exported package reproduces content', async () => {
    const first = await applyPacket(parsePacket(validCreate), NOW);
    const pkg = await exportCoursePackage(first.courseId);
    expect(parsePacket(pkg).kind).toBe('create-course');

    // import as a copy (rename to avoid confusion)
    pkg.course.name = 'Spanish Kitchen Copy';
    const second = await applyPacket(pkg, NOW + 5000);
    const items = await db.items.where('courseId').equals(second.courseId).toArray();
    expect(items).toHaveLength(2);
    const types = await db.itemTypes.where('courseId').equals(second.courseId).toArray();
    expect(types[0].templates.map((t) => t.name).sort()).toEqual(['Meaning', 'Production']);
    // record-form synonyms survive the trip
    const sarten = items.find((i) => Object.values(i.fieldValues).includes('la sartén'))!;
    expect(Object.values(sarten.synonyms).every((s) => s.includes('pan'))).toBe(true);
  });
});
