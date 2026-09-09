import { z } from 'zod';

const count = z.number().int().min(0);
const snapshotItemSchema = z
  .object({
    id: z.string().min(1),
    type: z.string(),
    /** Course level — the unit, for planned courses. */
    level: z.number().int().min(1),
    preview: z.string(),
    fields: z.record(z.string(), z.string()),
    status: z.enum(['locked', 'lesson', 'active']),
    stageIndex: count.nullable(),
    reviews: count,
    lapses: count,
    note: z.string().optional(),
  })
  .passthrough();

const snapshotTemplateSchema = z
  .object({
    name: z.string(),
    promptFields: z.array(z.string()),
    answerField: z.string(),
    // Earlier version-1 publishers omitted grading and progressive-hint metadata.
    mode: z.enum(['typed', 'choice', 'sentenceCloze', 'self', 'cloze']).optional(),
    answerLang: z.enum(['latin', 'kana']).optional(),
    typoTolerance: z.boolean().optional(),
    choices: z.number().int().min(2).max(6).optional(),
    rotation: z.enum(['random', 'sequential']).optional(),
    hintFields: z.array(z.string()).optional(),
  })
  .passthrough();

export const snapshotCourseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string(),
    scheduling: z.enum(['ladder', 'fsrs']),
    ladder: z
      .object({
        name: z.string(),
        stages: z.array(z.string()),
        passesAtIndex: count,
      })
      .passthrough()
      .nullable(),
    lessons: z.object({ newPerDay: count, batchSize: z.number().int().min(1) }),
    currentLevel: z.number().int().min(1).optional(),
    plan: z
      .object({
        releaseMode: z.enum(['progress', 'schedule', 'manual']),
        hasMaterial: z.boolean(),
        units: z.array(
          z
            .object({
              level: z.number().int().min(1),
              title: z.string(),
              summary: z.string(),
              topics: z.array(z.string()),
              targetCount: count,
              released: z.boolean(),
              releaseAt: z.string().nullable(),
              pendingProposals: count,
            })
            .passthrough(),
        ),
      })
      .passthrough()
      .nullable()
      .optional(),
    itemTypes: z.array(
      z
        .object({
          name: z.string(),
          icon: z.string(),
          fields: z.array(
            z.object({
              name: z.string(),
              kind: z.enum(['text', 'richtext', 'image', 'audio', 'list', 'clozeSentences']),
            }),
          ),
          templates: z.array(snapshotTemplateSchema),
        })
        .passthrough(),
    ),
    counts: z
      .object({
        items: count,
        lessonQueue: count,
        active: count,
        dueNow: count,
        burnedCards: count,
        pendingProposals: count,
      })
      .catchall(count),
    items: z.array(snapshotItemSchema),
    struggling: z.array(snapshotItemSchema),
    itemsTruncated: z.boolean(),
  })
  .passthrough();

export const snapshotSchema = z
  .object({
    format: z.literal('srs-snapshot'),
    version: z.literal(1),
    generatedAt: z.number(),
    localDay: z.number(),
    courses: z.array(snapshotCourseSchema),
  })
  .passthrough();

export type SnapshotItem = z.infer<typeof snapshotItemSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type SnapshotCourse = z.infer<typeof snapshotCourseSchema>;
