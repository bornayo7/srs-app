import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import initSqlJs from 'sql.js';
import { cleanAnkiField, dedupeNames, parseApkg } from './apkg';

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
});

describe('parseApkg', () => {
  it('reads models and notes out of a constructed legacy apkg', async () => {
    // build a minimal legacy collection.anki2 with sql.js
    const SQL = await initSqlJs();
    const sqldb = new SQL.Database();
    sqldb.run('CREATE TABLE col (id INTEGER, models TEXT)');
    sqldb.run('CREATE TABLE notes (id INTEGER, mid INTEGER, flds TEXT)');
    const models = {
      '100': { name: 'Basic', flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }] },
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
