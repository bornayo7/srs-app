import JSZip from 'jszip';
import { containsKana, normalizeAnswer } from '@/engine/grading/normalize';
import { PACKET_FORMAT, PACKET_VERSION, parsePacket, type Packet } from '@/packages/schema';

/**
 * Anki .apkg reader — legacy schema (collection.anki2 / collection.anki21,
 * where notetypes live as JSON in col.models). Anki 23+ default exports use a
 * zstd-compressed anki21b; those need "Support older Anki versions" checked at
 * export time. sql.js (~1.5 MB wasm) loads lazily, only when importing.
 */

export interface AnkiModel {
  id: string;
  name: string;
  fieldNames: string[];
  noteCount: number;
}

export interface AnkiParsed {
  suggestedName: string;
  models: AnkiModel[];
  /** modelId → rows of cleaned field values (parallel to fieldNames). */
  notesByModel: Map<string, string[][]>;
  totalNotes: number;
}

export interface AnkiMapping {
  include: boolean;
  promptIdx: number;
  answerIdx: number;
}

/** Resolve the user's note mappings once, using the same packet boundary as other imports. */
export function buildAnkiPacket(
  parsed: AnkiParsed,
  mappings: Record<string, AnkiMapping>,
  name: string,
  cap = 2000,
): { packet: Packet; skipped: number } {
  if (!Number.isInteger(cap) || cap < 1 || cap > 2000)
    throw new Error('Import between 1 and 2000 notes at a time.');
  const included = parsed.models.filter((model) => mappings[model.id]?.include);
  if (!included.length) throw new Error('Choose at least one note type to import.');
  const typeNames = dedupeNames(included.map((model) => model.name));
  const resolved = included.map((model, index) => {
    const mapping = mappings[model.id];
    if (
      ![mapping.promptIdx, mapping.answerIdx].every(
        (field) => Number.isInteger(field) && field >= 0 && field < model.fieldNames.length,
      )
    )
      throw new Error(`"${model.name}": choose existing prompt and answer fields.`);
    if (mapping.promptIdx === mapping.answerIdx)
      throw new Error(
        `"${model.name}": prompt and typed answer are the same field. Pick different fields or exclude this type.`,
      );
    const fieldNames = dedupeNames(model.fieldNames);
    const answers = (parsed.notesByModel.get(model.id) ?? [])
      .map((row) => row[mapping.answerIdx]?.trim() ?? '')
      .filter((answer) => normalizeAnswer(answer));
    const answerLang =
      answers.length && answers.filter(containsKana).length > answers.length / 2 ? 'kana' : 'latin';
    return {
      model,
      mapping,
      fieldNames,
      spec: {
        name: typeNames[index],
        icon: '🗂️',
        fields: fieldNames.map((name) => ({ name })),
        templates: [
          {
            name: 'Card',
            promptFields: [fieldNames[mapping.promptIdx]],
            answerField: fieldNames[mapping.answerIdx],
            answerLang,
          },
        ],
      },
    };
  });
  const items: { type: string; fields: Record<string, string> }[] = [];
  let skipped = 0;
  outer: for (const { model, mapping, fieldNames, spec } of resolved) {
    for (const row of parsed.notesByModel.get(model.id) ?? []) {
      if (items.length >= cap) break outer;
      const fields = Object.fromEntries(
        fieldNames
          .map((name, index) => [name, row[index]?.trim() ?? ''])
          .filter(([, value]) => value),
      );
      if (
        !fields[fieldNames[mapping.promptIdx]] ||
        !normalizeAnswer(fields[fieldNames[mapping.answerIdx]] ?? '')
      ) {
        skipped++;
        continue;
      }
      items.push({ type: spec.name, fields });
    }
  }
  if (!items.length)
    throw new Error('No importable notes: the selected prompt or answer fields were empty.');
  return {
    packet: parsePacket({
      format: PACKET_FORMAT,
      version: PACKET_VERSION,
      kind: 'create-course',
      course: { name: name.trim(), description: `Imported from Anki (${parsed.totalNotes} notes)` },
      itemTypes: resolved.map(({ spec }) => spec),
      items,
    }),
    skipped,
  };
}

/** Anki fields are HTML — flatten to plain text for typed cards. */
export function cleanAnkiField(raw: string): string {
  return raw
    .replace(/\[sound:[^\]]*\]/g, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export async function parseApkg(data: ArrayBuffer, fileName: string): Promise<AnkiParsed> {
  const zip = await JSZip.loadAsync(data);
  const dbFile = zip.file('collection.anki21') ?? zip.file('collection.anki2');
  if (!dbFile) {
    if (zip.file('collection.anki21b')) {
      throw new Error(
        'This .apkg uses Anki\'s newest format. In Anki, re-export the deck with "Support older Anki versions" checked, then import that file.',
      );
    }
    throw new Error('No Anki collection found inside this file.');
  }

  const bytes = await dbFile.async('uint8array');
  const initSqlJs = (await import('sql.js')).default;
  const wasmUrl = (await import('sql.js/dist/sql-wasm.wasm?url')).default;
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const sqldb = new SQL.Database(bytes);
  try {
    const colRes = sqldb.exec('SELECT models FROM col LIMIT 1');
    if (colRes.length === 0) throw new Error('Empty Anki collection.');
    const modelsJson = JSON.parse(String(colRes[0].values[0][0])) as Record<string, unknown>;

    // tolerate malformed model entries (add-ons produce all sorts) — skip them
    const validModels = new Map<string, { name: string; fieldNames: string[] }>();
    for (const [id, raw] of Object.entries(modelsJson)) {
      const m = raw as { name?: unknown; flds?: unknown };
      if (typeof m?.name !== 'string' || !Array.isArray(m.flds)) continue;
      const flds = (m.flds as { name?: unknown; ord?: unknown }[]).filter(
        (f) => typeof f?.name === 'string',
      );
      if (flds.length === 0) continue;
      validModels.set(id, {
        name: m.name,
        fieldNames: [...flds]
          .sort((a, b) => ((a.ord as number) ?? 0) - ((b.ord as number) ?? 0))
          .map((f) => f.name as string),
      });
    }

    const notesByModel = new Map<string, string[][]>();
    const noteRes = sqldb.exec('SELECT mid, flds FROM notes');
    let totalNotes = 0;
    for (const row of noteRes[0]?.values ?? []) {
      const mid = String(row[0]);
      if (!validModels.has(mid)) continue; // dangling mid — unreachable from any mapping
      const fields = String(row[1]).split('\x1f').map(cleanAnkiField);
      const arr = notesByModel.get(mid) ?? [];
      arr.push(fields);
      notesByModel.set(mid, arr);
      totalNotes++;
    }

    const models: AnkiModel[] = [...validModels.entries()]
      .map(([id, m]) => ({
        id,
        name: m.name,
        fieldNames: m.fieldNames,
        noteCount: notesByModel.get(id)?.length ?? 0,
      }))
      .filter((m) => m.noteCount > 0)
      .sort((a, b) => b.noteCount - a.noteCount);

    if (models.length === 0) throw new Error('This deck contains no notes.');

    return {
      suggestedName:
        fileName
          .replace(/\.apkg$/i, '')
          .replace(/[_-]+/g, ' ')
          .trim() || 'Anki import',
      models,
      notesByModel,
      totalNotes,
    };
  } finally {
    sqldb.close();
  }
}

/** Make names unique case-insensitively (packet validation requires it). */
export function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((name) => {
    const base = name.trim() || 'Field';
    let candidate = base;
    for (let suffix = 2; seen.has(candidate.toLowerCase()); suffix++)
      candidate = `${base} (${suffix})`;
    seen.add(candidate.toLowerCase());
    return candidate;
  });
}
