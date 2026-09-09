import { z } from 'zod';
import { LEGACY_GENERATION } from '@/engine/revision';
import { BASE64_PATTERN, MEDIA_MIME_PATTERN } from './blobCodec';

const id = z.string().min(1);
const stamp = z.number().finite().min(-8.64e15).max(8.64e15);
const count = z.number().int().nonnegative();
const names = z.array(id);
const strings = z.array(z.string());
const sentence = z.object({
  text: z.string(),
  translation: z.string().optional(),
  hint: z.string().optional(),
});
const value = z.union([z.string(), strings, z.array(sentence)]);
const values = z.record(z.string(), value);
const answerMap = z.record(z.string(), strings);
const grading = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('typed'),
    answerLang: z.enum(['latin', 'kana']),
    typoTolerance: z.boolean(),
  }),
  z.object({ mode: z.literal('choice'), choices: z.number().int().min(2).max(6) }),
  z.object({
    mode: z.literal('sentenceCloze'),
    sentencesFieldId: id,
    rotation: z.enum(['random', 'sequential']),
  }),
]);
const field = z.object({
  id,
  name: id,
  kind: z.enum(['text', 'richtext', 'image', 'audio', 'list', 'clozeSentences']),
});
const template = z.object({
  id,
  name: id,
  promptFieldIds: names.min(1),
  answerFieldId: id,
  hintFieldIds: names,
  grading,
});
const type = z
  .object({
    id,
    courseId: id,
    name: id,
    color: z.string(),
    icon: z.string(),
    fields: z.array(field).min(1),
    templates: z.array(template).min(1),
    rev: count.default(0),
    generation: id.default(LEGACY_GENERATION),
    updatedAt: stamp,
  })
  .catchall(z.unknown());
const stage = z.object({ id, name: id, intervalMinutes: z.number().finite().positive() });
const ladder = z
  .object({
    id,
    courseId: id.nullable(),
    isPreset: z.boolean(),
    name: id,
    stages: z.array(stage).min(1),
    passesAtIndex: count,
    burnEnabled: z.boolean(),
    updatedAt: stamp,
  })
  .catchall(z.unknown());
const course = z
  .object({
    id,
    name: id,
    description: z.string(),
    scheduling: z.object({ kind: z.literal('ladder'), ladderId: id }),
    lessons: z.object({ newPerDay: count, batchSize: count.min(1) }),
    ghosts: z.enum(['off', 'minimal', 'on']),
    answerStyle: z.literal('perTemplate'),
    levelMode: z.enum(['levels', 'flat']),
    levelConfig: z
      .object({
        gateTypeIds: names,
        passPercent: z.number().min(1).max(100),
        autoAdvance: z.boolean().optional(),
      })
      .optional(),
    currentLevel: count.min(1),
    createdAt: stamp,
    updatedAt: stamp,
  })
  .catchall(z.unknown());
const item = z
  .object({
    id,
    courseId: id,
    typeId: id,
    level: count.min(1),
    fieldValues: values,
    prereqIds: names,
    status: z.enum(['locked', 'lesson', 'active']),
    unlockedAt: stamp.nullable(),
    passedAt: stamp.nullable(),
    synonyms: answerMap,
    blockList: answerMap,
    guidance: z.record(z.string(), z.array(z.object({ text: z.string(), message: z.string() }))),
    note: z.string(),
    rev: count.default(0),
    generation: id.default(LEGACY_GENERATION),
    createdAt: stamp,
    updatedAt: stamp,
  })
  .catchall(z.unknown());
const stats = z
  .object({ reviews: count, correct: count, lapses: count })
  .refine(
    (s) => s.correct <= s.reviews && s.lapses <= s.reviews,
    'Card statistics exceed the number of reviews',
  );
const srs = z.object({ kind: z.literal('ladder'), stageIndex: count }).nullable();
const snapshot = z
  .object({
    state: z.enum(['new', 'review', 'burned', 'suspended']),
    srs,
    dueAt: stamp.optional(),
    stats,
  })
  .superRefine((card, ctx) => {
    if (card.state === 'review' && (card.dueAt === undefined || card.srs === null))
      ctx.addIssue({ code: 'custom', message: 'A review card needs dueAt and SRS state' });
    if (card.state !== 'review' && card.dueAt !== undefined)
      ctx.addIssue({ code: 'custom', message: 'Only a review card may have dueAt' });
    if (card.state === 'new' && card.srs !== null)
      ctx.addIssue({ code: 'custom', message: 'A new card must have null SRS state' });
  });
const card = snapshot
  .safeExtend({
    id,
    itemId: id,
    courseId: id,
    templateId: id,
    isGhost: z.boolean().optional(),
    parentCardId: id.optional(),
    rev: count.default(0),
    generation: id.default(LEGACY_GENERATION),
    updatedAt: stamp,
  })
  .catchall(z.unknown());
const log = z
  .object({
    id,
    cardId: id,
    itemId: id,
    courseId: id,
    ts: stamp,
    sessionId: id,
    kind: z.enum(['review', 'lesson', 'migration', 'manual']),
    prev: snapshot,
    outcome: z
      .object({
        kind: z.literal('ladder'),
        incorrectCount: count,
        fromStage: count,
        toStage: count,
      })
      .optional(),
    cardMeta: z
      .object({ templateId: id, isGhost: z.boolean().optional(), parentCardId: id.optional() })
      .optional(),
    appliedRev: count.optional(),
    itemRev: count.optional(),
    typeRev: count.optional(),
    appliedGeneration: id.optional(),
    itemGeneration: id.optional(),
    typeGeneration: id.optional(),
  })
  .catchall(z.unknown());
const media = z.object({
  id,
  mimeType: z.string().regex(MEDIA_MIME_PATTERN, 'Unsupported media type'),
  name: z.string(),
  createdAt: stamp,
  data: z.string().regex(BASE64_PATTERN, 'Invalid base64 media'),
});
const unit = z.object({
  level: count.min(1),
  title: id,
  summary: z.string(),
  topics: strings,
  targetCount: count,
  releaseAt: stamp.optional(),
  generatedAt: stamp.optional(),
});
const plan = z
  .object({
    id,
    courseId: id,
    title: z.string(),
    material: z.string(),
    materialTruncated: z.boolean(),
    releaseMode: z.enum(['progress', 'schedule', 'manual']),
    units: z.array(unit).min(1),
    createdAt: stamp,
    updatedAt: stamp,
  })
  .catchall(z.unknown());
const proposalItem = z.object({
  type: z.string().optional(),
  key: id.optional(),
  prereqs: names.optional(),
  fields: values,
  synonyms: z.union([strings, answerMap]).optional(),
  blockList: answerMap.optional(),
  guidance: z
    .record(z.string(), z.array(z.object({ text: z.string(), message: z.string() })))
    .optional(),
  note: z.string().optional(),
  level: count.min(1).optional(),
});
const proposal = z
  .object({
    id,
    courseId: id,
    planId: id.nullable(),
    level: count.min(1),
    item: proposalItem,
    source: z.enum(['ai', 'mcp', 'manual']),
    status: z.enum(['pending', 'accepted', 'rejected']),
    error: z.string().nullable(),
    duplicateOf: id.nullable(),
    rejectReason: z.string().nullable(),
    acceptedItemId: id.nullable(),
    createdAt: stamp,
    decidedAt: stamp.nullable(),
    updatedAt: stamp,
  })
  .catchall(z.unknown());
const tombstone = z.object({
  id,
  itemId: id,
  courseId: id,
  templateId: id,
  rev: count,
  generation: id.default(LEGACY_GENERATION),
  logId: id,
});
const receipt = z.object({ id, digest: id, importedAt: stamp, courseIds: names });
const dailyLesson = z.object({ id, courseId: id, day: z.iso.date(), itemIds: names });

/** Format 1 is the complete shipped model; format 2 adds revisions and receipts. */
const backupRecords = z.object({
  app: z.literal('srs-app'),
  formatVersion: z.union([z.literal(1), z.literal(2)]),
  exportedAt: stamp,
  data: z.object({
    courses: z.array(course),
    ladders: z.array(ladder),
    itemTypes: z.array(type),
    items: z.array(item),
    cards: z.array(card),
    reviewLogs: z.array(log),
    meta: z.array(z.object({ key: id, value: z.unknown() })),
    captures: z.array(z.object({ id, text: z.string(), createdAt: stamp })).default([]),
    media: z.array(media).default([]),
    plans: z.array(plan).default([]),
    proposals: z.array(proposal).default([]),
    cardTombstones: z.array(tombstone).default([]),
    packetReceipts: z.array(receipt).default([]),
    dailyLessons: z.array(dailyLesson).default([]),
  }),
});
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export const backupSchema = z.preprocess((raw, ctx) => {
  if (!isRecord(raw) || raw.formatVersion !== 2 || !isRecord(raw.data)) return raw;
  for (const table of ['items', 'itemTypes', 'cards', 'cardTombstones']) {
    const rows = raw.data[table];
    if (!Array.isArray(rows)) continue;
    for (const [index, row] of rows.entries()) {
      if (isRecord(row) && row.rev === undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['data', table, index, 'rev'],
          message: 'Format 2 requires a content revision',
        });
      if (isRecord(row) && row.generation === undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['data', table, index, 'generation'],
          message: 'Format 2 requires a record generation',
        });
    }
  }
  for (const table of [
    'captures',
    'media',
    'plans',
    'proposals',
    'cardTombstones',
    'packetReceipts',
    'dailyLessons',
  ]) {
    if (raw.data[table] === undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['data', table],
        message: 'Format 2 requires every study table',
      });
  }
  return raw;
}, backupRecords);
export type DecodedBackup = z.infer<typeof backupSchema>;
