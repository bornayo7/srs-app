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

describe('prerequisites and levels through packets', () => {
  const gated = {
    format: PACKET_FORMAT,
    version: PACKET_VERSION,
    kind: 'create-course',
    course: { name: 'Gated', levelMode: 'levels', gateTypes: ['Kanji'], passPercent: 90 },
    itemTypes: [
      {
        name: 'Radical',
        fields: [{ name: 'Sign' }, { name: 'Meaning' }],
        templates: [{ name: 'Meaning', promptFields: ['Sign'], answerField: 'Meaning' }],
      },
      {
        name: 'Kanji',
        fields: [{ name: 'Char' }, { name: 'Meaning' }],
        templates: [{ name: 'Meaning', promptFields: ['Char'], answerField: 'Meaning' }],
      },
    ],
    items: [
      { type: 'Radical', key: 'r1', fields: { Sign: '亅', Meaning: 'barb' } },
      { type: 'Kanji', key: 'k1', prereqs: ['r1'], fields: { Char: '了', Meaning: 'finish' } },
      { type: 'Kanji', key: 'k2', prereqs: ['r1'], level: 2, fields: { Char: '予', Meaning: 'beforehand' } },
    ],
  };

  it('resolves prereq keys to ids and locks dependents at import', async () => {
    const res = await applyPacket(parsePacket(gated), NOW);
    const items = await db.items.where('courseId').equals(res.courseId).toArray();
    const radical = items.find((i) => Object.values(i.fieldValues).includes('亅'))!;
    const kanji = items.find((i) => Object.values(i.fieldValues).includes('了'))!;
    const level2 = items.find((i) => Object.values(i.fieldValues).includes('予'))!;

    expect(radical.status).toBe('lesson'); // no prereqs, level 1
    expect(kanji.prereqIds).toEqual([radical.id]); // key → real id
    expect(kanji.status).toBe('locked');
    expect(level2.level).toBe(2);
    expect(level2.status).toBe('locked');

    const course = (await db.courses.get(res.courseId))!;
    expect(course.levelMode).toBe('levels');
    const kanjiType = (await db.itemTypes.where('courseId').equals(res.courseId).toArray()).find(
      (t) => t.name === 'Kanji',
    )!;
    expect(course.levelConfig).toEqual({ gateTypeIds: [kanjiType.id], passPercent: 90 });
  });

  it('rejects a prereq that is not defined earlier in the packet', () => {
    const bad = structuredClone(gated) as { items: { prereqs?: string[] }[] };
    bad.items[0].prereqs = ['nope'];
    expect(() => parsePacket(bad)).toThrow(/unknown prerequisite "nope"/);
  });

  it('rejects duplicate item keys and unknown gate types', () => {
    const dupKey = structuredClone(gated) as { items: { key?: string }[] };
    dupKey.items[1].key = 'r1';
    expect(() => parsePacket(dupKey)).toThrow(/duplicate item key/);

    const badGate = structuredClone(gated) as { course: { gateTypes?: string[] } };
    badGate.course.gateTypes = ['Vocab'];
    expect(() => parsePacket(badGate)).toThrow(/unknown item type "Vocab"/);
  });

  it('export → import preserves the dependency graph and level config', async () => {
    const first = await applyPacket(parsePacket(gated), NOW);
    const pkg = await exportCoursePackage(first.courseId);
    expect(pkg.course.levelMode).toBe('levels');
    expect(pkg.course.gateTypes).toEqual(['Kanji']);
    // prereqs must reference something defined earlier in the emitted array
    const seen = new Set<string>();
    for (const it of pkg.items) {
      for (const ref of it.prereqs ?? []) expect(seen.has(ref)).toBe(true);
      if (it.key) seen.add(it.key);
    }

    pkg.course.name = 'Gated Copy';
    const second = await applyPacket(parsePacket(pkg), NOW + 1000);
    const items = await db.items.where('courseId').equals(second.courseId).toArray();
    const radical = items.find((i) => Object.values(i.fieldValues).includes('亅'))!;
    const kanji = items.find((i) => Object.values(i.fieldValues).includes('了'))!;
    expect(kanji.prereqIds).toEqual([radical.id]);
    expect(kanji.status).toBe('locked');
  });
});

describe('sentence-cloze course round trip', () => {
  it('export preserves the clozeSentences kind so re-import stays a cloze course', async () => {
    const { clozeSeed } = await import('@/db/seed/cloze');
    const courseId = await installSeed(clozeSeed, NOW);
    const pkg = await exportCoursePackage(courseId);
    expect(pkg.itemTypes[0].fields.find((f) => f.name === 'Sentences')?.kind).toBe(
      'clozeSentences',
    );

    pkg.course.name = 'Cloze Copy';
    const res = await applyPacket(parsePacket(pkg), NOW + 1000);
    const types = await db.itemTypes.where('courseId').equals(res.courseId).toArray();
    const tpl = types[0].templates.find((t) => t.name === 'Cloze')!;
    expect(tpl.grading.mode).toBe('sentenceCloze');
    if (tpl.grading.mode === 'sentenceCloze') {
      const sentencesField = types[0].fields.find((f) => f.name === 'Sentences')!;
      expect(tpl.grading.sentencesFieldId).toBe(sentencesField.id);
    }
    const items = await db.items.where('courseId').equals(res.courseId).toArray();
    expect(items.length).toBe(clozeSeed.items.length);
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
