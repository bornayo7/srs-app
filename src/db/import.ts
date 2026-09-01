import { z } from 'zod';
import { db, ensurePresets } from './db';
import type { BackupFile, ExportedMedia } from './export';
import { EXPORT_FORMAT_VERSION } from './export';
import { base64ToBlob } from './blobCodec';

// Validation is deliberately structural (ids + relationships + the fields the
// engine depends on), with catchall passthrough so forward-compatible extras
// survive a round trip.

const stage = z
  .object({ id: z.string(), name: z.string(), intervalMinutes: z.number().positive() })
  .catchall(z.unknown());

const ladder = z
  .object({
    id: z.string(),
    courseId: z.string().nullable(),
    isPreset: z.boolean(),
    name: z.string(),
    stages: z.array(stage).min(1),
    passesAtIndex: z.number().int().min(0),
    burnEnabled: z.boolean(),
  })
  .catchall(z.unknown());

const course = z
  .object({
    id: z.string(),
    name: z.string(),
    scheduling: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('ladder'), ladderId: z.string() }).catchall(z.unknown()),
      z
        .object({ kind: z.literal('fsrs'), passIntervalDays: z.number() })
        .catchall(z.unknown()),
    ]),
    lessons: z.object({ newPerDay: z.number(), batchSize: z.number() }).catchall(z.unknown()),
    currentLevel: z.number(),
  })
  .catchall(z.unknown());

const itemType = z
  .object({
    id: z.string(),
    courseId: z.string(),
    name: z.string(),
    fields: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string() }).catchall(z.unknown())),
    templates: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          promptFieldIds: z.array(z.string()),
          answerFieldId: z.string(),
        })
        .catchall(z.unknown()),
    ),
  })
  .catchall(z.unknown());

const item = z
  .object({
    id: z.string(),
    courseId: z.string(),
    typeId: z.string(),
    level: z.number(),
    fieldValues: z.record(z.string(), z.unknown()),
    prereqIds: z.array(z.string()),
    status: z.enum(['locked', 'lesson', 'active']),
  })
  .catchall(z.unknown());

const srsState = z.union([
  z.object({ kind: z.literal('ladder'), stageIndex: z.number().int().min(0) }).catchall(z.unknown()),
  z.object({ kind: z.literal('fsrs') }).catchall(z.unknown()),
]);

const card = z
  .object({
    id: z.string(),
    itemId: z.string(),
    courseId: z.string(),
    templateId: z.string(),
    state: z.enum(['new', 'review', 'burned', 'suspended']),
    srs: srsState.nullable(),
    dueAt: z.number().optional(),
    stats: z
      .object({ reviews: z.number(), correct: z.number(), lapses: z.number() })
      .catchall(z.unknown()),
  })
  .catchall(z.unknown())
  .superRefine((c, ctx) => {
    // invariants the compound due-indexes and queue logic depend on
    if (c.state === 'review' && (c.dueAt === undefined || c.srs === null)) {
      ctx.addIssue({ code: 'custom', message: `review card ${c.id} must have dueAt and srs` });
    }
    if (c.state !== 'review' && c.dueAt !== undefined) {
      ctx.addIssue({ code: 'custom', message: `${c.state} card ${c.id} must not have dueAt` });
    }
    if (c.state === 'new' && c.srs !== null) {
      ctx.addIssue({ code: 'custom', message: `new card ${c.id} must have srs null` });
    }
  });

const reviewLog = z
  .object({
    id: z.string(),
    cardId: z.string(),
    itemId: z.string(),
    courseId: z.string(),
    ts: z.number(),
    sessionId: z.string(),
    kind: z.enum(['review', 'lesson', 'migration', 'manual']),
  })
  .catchall(z.unknown());

const metaRow = z.object({ key: z.string(), value: z.unknown() }).catchall(z.unknown());

const capture = z
  .object({ id: z.string(), text: z.string(), createdAt: z.number() })
  .catchall(z.unknown());

const media = z.object({
  id: z.string(),
  mimeType: z.string(),
  name: z.string(),
  createdAt: z.number(),
  data: z.string(), // base64
});

const planUnit = z
  .object({ level: z.number().int().min(1), title: z.string() })
  .catchall(z.unknown());

const plan = z
  .object({
    id: z.string(),
    courseId: z.string(),
    releaseMode: z.enum(['progress', 'schedule', 'manual']),
    units: z.array(planUnit),
  })
  .catchall(z.unknown());

const proposal = z
  .object({
    id: z.string(),
    courseId: z.string(),
    level: z.number(),
    status: z.enum(['pending', 'accepted', 'rejected']),
    item: z.object({ fields: z.record(z.string(), z.unknown()) }).catchall(z.unknown()),
  })
  .catchall(z.unknown());

export const backupSchema = z.object({
  app: z.literal('srs-app'),
  formatVersion: z.literal(EXPORT_FORMAT_VERSION),
  exportedAt: z.number(),
  data: z.object({
    courses: z.array(course),
    ladders: z.array(ladder),
    itemTypes: z.array(itemType),
    items: z.array(item),
    cards: z.array(card),
    reviewLogs: z.array(reviewLog),
    meta: z.array(metaRow),
    captures: z.array(capture).optional(), // added in schema v2 backups
    media: z.array(media).optional(), // added when P3 introduced image fields
    plans: z.array(plan).optional(), // P4 course plans
    proposals: z.array(proposal).optional(), // P4 review queue
  }),
});

/**
 * Restore a backup, REPLACING the current database contents.
 * Throws (and changes nothing) if validation fails — the transaction guarantees it.
 */
/** Keys that live only in this browser and must survive a backup restore. */
const LOCAL_ONLY_META_KEYS = [
  'exchange:dirHandle',
  'ai:apiKey',
  'ai:openaiKey',
  'ai:model',
  'ai:openaiModel',
  'ai:openaiBaseUrl',
  'ai:provider',
];

export async function importAll(raw: unknown): Promise<{ courses: number; items: number }> {
  const parsed = backupSchema.parse(raw) as unknown as BackupFile;

  // decode media before the transaction: base64→Blob is synchronous, but doing
  // it up front means a corrupt asset fails the import instead of half-applying
  const mediaRows = ((parsed.data.media ?? []) as ExportedMedia[]).map((m) => ({
    id: m.id,
    blob: base64ToBlob(m.data, m.mimeType),
    mimeType: m.mimeType,
    name: m.name,
    createdAt: m.createdAt,
  }));

  await db.transaction(
    'rw',
    [
      db.courses,
      db.ladders,
      db.itemTypes,
      db.items,
      db.cards,
      db.reviewLogs,
      db.meta,
      db.captures,
      db.media,
      db.plans,
      db.proposals,
    ],
    async () => {
      // backups exclude these on purpose — carry them across the wipe
      const localOnly = (await db.meta.bulkGet(LOCAL_ONLY_META_KEYS)).filter(
        (r): r is NonNullable<typeof r> => r !== undefined,
      );
      await Promise.all([
        db.courses.clear(),
        db.ladders.clear(),
        db.itemTypes.clear(),
        db.items.clear(),
        db.cards.clear(),
        db.reviewLogs.clear(),
        db.meta.clear(),
        db.captures.clear(),
        db.media.clear(),
        db.plans.clear(),
        db.proposals.clear(),
      ]);
      await db.meta.bulkPut(localOnly);
      /* eslint-disable @typescript-eslint/no-explicit-any */
      await db.courses.bulkAdd(parsed.data.courses as any[]);
      await db.ladders.bulkAdd(parsed.data.ladders as any[]);
      await db.itemTypes.bulkAdd(parsed.data.itemTypes as any[]);
      await db.items.bulkAdd(parsed.data.items as any[]);
      await db.cards.bulkAdd(parsed.data.cards as any[]);
      await db.reviewLogs.bulkAdd(parsed.data.reviewLogs as any[]);
      // bulkPut, not bulkAdd: keys may overlap the preserved local-only rows
      await db.meta.bulkPut(parsed.data.meta as any[]);
      if (parsed.data.captures) await db.captures.bulkAdd(parsed.data.captures as any[]);
      if (mediaRows.length > 0) await db.media.bulkAdd(mediaRows);
      if (parsed.data.plans) await db.plans.bulkAdd(parsed.data.plans as any[]);
      if (parsed.data.proposals) await db.proposals.bulkAdd(parsed.data.proposals as any[]);
      /* eslint-enable @typescript-eslint/no-explicit-any */
    },
  );
  // idempotent: guarantees the built-in presets exist even if the backup
  // predates one of them or was hand-edited — course creation depends on them
  await ensurePresets();

  return { courses: parsed.data.courses.length, items: parsed.data.items.length };
}
