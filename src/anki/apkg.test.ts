import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import initSqlJs from 'sql.js';
import { buildAnkiPacket, cleanAnkiField, dedupeNames, parseApkg, type AnkiParsed } from './apkg';

describe('cleanAnkiField', () => {
  it('strips HTML, sound tags, and entities', () => {
    expect(cleanAnkiField('<b>bonjour</b><br>[sound:hi.mp3] &amp; ça&nbsp;va')).toBe(
      'bonjour & ça va',
    );
  });
});

describe('dedupeNames', () => {
  it('suffixes case-insensitive collisions', () => {
    expect(dedupeNames(['Front', 'front', 'Back'])).toEqual(['Front', 'front (2)', 'Back']);
  });
  it('reserves emitted suffixes when they collide with later input names', () => {
    expect(dedupeNames(['Front', 'front', 'front (2)', 'FRONT'])).toEqual([
      'Front',
      'front (2)',
      'front (2) (2)',
      'FRONT (3)',
    ]);
  });
});

describe('buildAnkiPacket', () => {
  const parsed = (): AnkiParsed => ({
    suggestedName: 'Japanese',
    totalNotes: 4,
    models: [
      { id: 'basic', name: 'Basic', fieldNames: ['Front', 'Front', 'front (2)'], noteCount: 4 },
    ],
    notesByModel: new Map([
      [
        'basic',
        [
          ['cat', 'ねこ', 'extra'],
          ['dog', 'いぬ', 'extra'],
          ['empty', '...', 'extra'],
          ['bird', 'とり', 'extra'],
        ],
      ],
    ]),
  });
  it('keeps unique field names, infers kana, and caps successful notes', () => {
    const { packet, skipped } = buildAnkiPacket(
      parsed(),
      { basic: { include: true, promptIdx: 0, answerIdx: 1 } },
      'Japanese',
      3,
    );
    expect(packet.kind).toBe('create-course');
    if (packet.kind !== 'create-course') throw new Error('wrong packet kind');
    expect(packet.items).toHaveLength(3);
    expect(skipped).toBe(1);
    expect(packet.itemTypes[0].fields.map((field) => field.name)).toEqual([
      'Front',
      'Front (2)',
      'front (2) (2)',
    ]);
    expect(packet.itemTypes[0].templates[0].answerLang).toBe('kana');
    expect(packet.items[0].fields).toEqual({
      Front: 'cat',
      'Front (2)': 'ねこ',
      'front (2) (2)': 'extra',
    });
  });
  it('rejects equal, fractional, or absent mapping positions', () => {
    for (const answerIdx of [0, 0.5, 99])
      expect(() =>
        buildAnkiPacket(
          parsed(),
          { basic: { include: true, promptIdx: 0, answerIdx } },
          'Japanese',
        ),
      ).toThrow(/field/i);
    expect(() => buildAnkiPacket(parsed(), {}, 'Japanese')).toThrow(/at least one/);
  });
  it('does not create a course when every mapped answer is unanswerable', () => {
    const source = parsed();
    source.notesByModel.set('basic', [
      ['q', '...'],
      ['q2', ' '],
    ]);
    expect(() =>
      buildAnkiPacket(source, { basic: { include: true, promptIdx: 0, answerIdx: 1 } }, 'Japanese'),
    ).toThrow(/No importable notes/);
  });
});

describe('parseApkg', () => {
  it('reads models and notes out of a constructed legacy apkg', async () => {
    // build a minimal legacy collection.anki2 with sql.js
    const SQL = await initSqlJs();
    const sqldb = new SQL.Database();
    sqldb.run('CREATE TABLE col (id INTEGER, models TEXT)');
    sqldb.run('CREATE TABLE notes (id INTEGER, mid INTEGER, flds TEXT)');
    const models = {
      '100': {
        name: 'Basic',
        flds: [
          { name: 'Front', ord: 0 },
          { name: 'Back', ord: 1 },
        ],
      },
    };
    sqldb.run('INSERT INTO col VALUES (1, ?)', [JSON.stringify(models)]);
    const sep = String.fromCharCode(31);
    sqldb.run('INSERT INTO notes VALUES (1, 100, ?)', [`<b>chat</b>${sep}cat`]);
    sqldb.run('INSERT INTO notes VALUES (2, 100, ?)', [`chien${sep}dog`]);
    const bytes = sqldb.export();
    sqldb.close();

    const zip = new JSZip();
    zip.file('collection.anki2', bytes);
    const apkg = await zip.generateAsync({ type: 'arraybuffer' });

    const parsed = await parseApkg(apkg, 'French_Basics.apkg');
    expect(parsed.suggestedName).toBe('French Basics');
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0].fieldNames).toEqual(['Front', 'Back']);
    expect(parsed.models[0].noteCount).toBe(2);
    const rows = parsed.notesByModel.get('100')!;
    expect(rows[0]).toEqual(['chat', 'cat']);
    expect(rows[1]).toEqual(['chien', 'dog']);
  });

  it('gives the legacy-export hint for anki21b-only files', async () => {
    const zip = new JSZip();
    zip.file('collection.anki21b', new Uint8Array([1, 2, 3]));
    const apkg = await zip.generateAsync({ type: 'arraybuffer' });
    await expect(parseApkg(apkg, 'x.apkg')).rejects.toThrow(/Support older Anki versions/);
  });
});
