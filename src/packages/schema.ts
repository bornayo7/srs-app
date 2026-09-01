import { z } from 'zod';

/**
 * The srs-packet format: one JSON shape, three producers — the MCP server,
 * in-app AI generation, and hand-written files — all validated here before
 * anything touches the database.
 *
 * Kinds:
 *   create-course  — course + types + items, imported straight in
 *   add-items      — items into an existing course, imported straight in
 *   course-plan    — course + types + ordered UNITS; the units' items go to
 *                    the review queue (proposals), not the course (P4)
 *   propose-items  — items into an existing course's review queue (P4)
 *
 * NOTE: this file is also imported by srs-mcp (which may resolve zod v3), so
 * stick to zod syntax that is identical in v3 and v4: two-arg z.record,
 * z.discriminatedUnion, z.enum, .optional, .min, .extend.
 */

export const PACKET_FORMAT = 'srs-packet' as const;
export const PACKET_VERSION = 1 as const;

const clozeSentence = z.object({
  text: z.string().min(1), // blank marked ⟦like this⟧
  translation: z.string().optional(),
  hint: z.string().optional(),
});

const fieldValue = z.union([z.string(), z.array(z.string()), z.array(clozeSentence)]);

export const packetItemSchema = z.object({
  /** ItemType NAME; may be omitted when the course has exactly one type. */
  type: z.string().optional(),
  /** Local handle other items in this packet can list as a prerequisite. */
  key: z.string().min(1).optional(),
  /**
   * Prerequisites: `key`s of earlier items in this packet (or existing item
   * ids). The item stays locked until all of them reach the pass stage.
   */
  prereqs: z.array(z.string()).optional(),
  /** Field NAME → value. */
  fields: z.record(z.string(), fieldValue),
  /**
   * Extra accepted answers. Array form applies to every template of the type;
   * record form maps template NAME → synonyms.
   */
  synonyms: z.union([z.array(z.string()), z.record(z.string(), z.array(z.string()))]).optional(),
  note: z.string().optional(),
  level: z.number().int().min(1).optional(),
});
export type PacketItem = z.infer<typeof packetItemSchema>;

export const packetTemplateSchema = z.object({
  name: z.string().min(1),
  promptFields: z.array(z.string()).min(1),
  answerField: z.string().min(1),
  /**
   * 'typed' (default) asks the learner to type the answer; 'choice' shows
   * buttons, with the wrong options taken from other items of the same type.
   */
  mode: z.enum(['typed', 'choice']).optional(),
  /** Options shown in 'choice' mode, 2–6 (default 4). */
  choices: z.number().int().min(2).max(6).optional(),
  answerLang: z.enum(['latin', 'kana']).optional(), // default latin
  typoTolerance: z.boolean().optional(), // default true
});

export const packetItemTypeSchema = z.object({
  name: z.string().min(1),
  icon: z.string().optional(),
  color: z.string().optional(),
  fields: z
    .array(
      z.object({
        name: z.string().min(1),
        kind: z.enum(['text', 'list', 'clozeSentences']).optional(),
      }),
    )
    .min(1),
  templates: z.array(packetTemplateSchema).min(1),
});

function findDuplicate(names: string[]): string | null {
  const seen = new Set<string>();
  for (const n of names) {
    const key = n.toLowerCase();
    if (seen.has(key)) return n;
    seen.add(key);
  }
  return null;
}

/** Course settings shared by every course-creating kind. */
const courseSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /** Built-in ladder preset; default classic. */
  ladderPreset: z.enum(['classic', 'gentle', 'bunpro']).optional(),
  newPerDay: z.number().int().min(0).optional(),
  batchSize: z.number().int().min(1).optional(),
  /** 'levels' gates content behind level-ups; default 'flat'. */
  levelMode: z.enum(['flat', 'levels']).optional(),
  /** Item type NAMES whose passing drives level-ups (default: all types). */
  gateTypes: z.array(z.string()).optional(),
  passPercent: z.number().int().min(1).max(100).optional(),
  /**
   * Levels only. false = the level never advances on its own (a plan's
   * manual/scheduled release owns it). Default true.
   */
  autoAdvance: z.boolean().optional(),
});

export const createCoursePacketSchema = z.object({
  format: z.literal(PACKET_FORMAT),
  version: z.literal(PACKET_VERSION),
  kind: z.literal('create-course'),
  course: courseSpecSchema,
  itemTypes: z.array(packetItemTypeSchema).min(1),
  items: z.array(packetItemSchema),
});
export type CreateCoursePacket = z.infer<typeof createCoursePacketSchema>;

export const addItemsPacketSchema = z.object({
  format: z.literal(PACKET_FORMAT),
  version: z.literal(PACKET_VERSION),
  kind: z.literal('add-items'),
  /** Target course — by id (preferred, from snapshot.json) or by exact name. */
  courseId: z.string().optional(),
  courseName: z.string().optional(),
  items: z.array(packetItemSchema).min(1),
});
export type AddItemsPacket = z.infer<typeof addItemsPacketSchema>;

// ---------- P4: course plans + the review queue ----------

/** ISO date / date-time string, or epoch ms. */
const releaseAtSchema = z.union([z.string().min(1), z.number()]);

export const packetUnitSchema = z.object({
  title: z.string().min(1),
  summary: z.string().optional(),
  topics: z.array(z.string()).optional(),
  /** Suggested number of items for this unit (drives generation). */
  targetCount: z.number().int().min(0).optional(),
  /** When this unit opens (schedule release mode), e.g. "2026-09-15". */
  releaseAt: releaseAtSchema.optional(),
  /** Proposed items — they land in the review queue, not the course. */
  items: z.array(packetItemSchema).optional(),
});
export type PacketUnit = z.infer<typeof packetUnitSchema>;

export const coursePlanPacketSchema = z.object({
  format: z.literal(PACKET_FORMAT),
  version: z.literal(PACKET_VERSION),
  kind: z.literal('course-plan'),
  course: courseSpecSchema.extend({
    /**
     * progress (default): the level engine opens the next unit when enough of
     * this one passes; schedule: units open on their releaseAt dates; manual:
     * only an explicit "release next unit" opens one.
     */
    releaseMode: z.enum(['progress', 'schedule', 'manual']).optional(),
  }),
  itemTypes: z.array(packetItemTypeSchema).min(1),
  /** Units in course order — unit N becomes level N. */
  units: z.array(packetUnitSchema).min(1),
  /** The source material the plan was built from (kept for later generation). */
  material: z.string().optional(),
});
export type CoursePlanPacket = z.infer<typeof coursePlanPacketSchema>;

export const proposeItemsPacketSchema = z.object({
  format: z.literal(PACKET_FORMAT),
  version: z.literal(PACKET_VERSION),
  kind: z.literal('propose-items'),
  courseId: z.string().optional(),
  courseName: z.string().optional(),
  /** Default unit (level) for items that don't set their own; default: the course's current level. */
  unit: z.number().int().min(1).optional(),
  items: z.array(packetItemSchema).min(1),
});
export type ProposeItemsPacket = z.infer<typeof proposeItemsPacketSchema>;

/** Resolve a unit's releaseAt to epoch ms; null when absent or unreadable. */
export function parseReleaseAt(v: string | number | undefined): number | null {
  if (v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

type AnyPacket =
  | z.infer<typeof createCoursePacketSchema>
  | z.infer<typeof addItemsPacketSchema>
  | z.infer<typeof coursePlanPacketSchema>
  | z.infer<typeof proposeItemsPacketSchema>;

/** Every item in a packet with the path it lives at, for error reporting. */
function itemsWithPaths(packet: AnyPacket): { item: PacketItem; path: (string | number)[] }[] {
  if (packet.kind === 'course-plan') {
    return packet.units.flatMap((u, ui) =>
      (u.items ?? []).map((item, ii) => ({ item, path: ['units', ui, 'items', ii] })),
    );
  }
  return packet.items.map((item, i) => ({ item, path: ['items', i] }));
}

// discriminatedUnion needs plain objects, so name-uniqueness refinement lives
// on the union. Names are lookup keys (resolved case-insensitively) —
// collisions would silently misroute data, so reject them at the boundary.
export const packetSchema = z
  .discriminatedUnion('kind', [
    createCoursePacketSchema,
    addItemsPacketSchema,
    coursePlanPacketSchema,
    proposeItemsPacketSchema,
  ])
  .superRefine((packet, ctx) => {
    // Prereq handles: unique, and referenced only after they're defined.
    // "Earlier in the packet" is required (and makes cycles impossible) —
    // author content in dependency order: radicals, then kanji, then vocab.
    // Kinds that target an EXISTING course may also reference existing item
    // ids — those are resolved (and validated) at import time.
    const createsCourse = packet.kind === 'create-course' || packet.kind === 'course-plan';
    const seenKeys = new Set<string>();
    for (const { item, path } of itemsWithPaths(packet)) {
      for (const ref of item.prereqs ?? []) {
        if (!seenKeys.has(ref) && createsCourse) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'prereqs'],
            message: `unknown prerequisite "${ref}" — reference the "key" of an item defined earlier in this packet`,
          });
        }
      }
      if (item.key) {
        if (seenKeys.has(item.key)) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'key'],
            message: `duplicate item key "${item.key}"`,
          });
        }
        seenKeys.add(item.key);
      }
    }

    if (packet.kind === 'course-plan') {
      for (const [i, unit] of packet.units.entries()) {
        if (unit.releaseAt !== undefined && parseReleaseAt(unit.releaseAt) === null) {
          ctx.addIssue({
            code: 'custom',
            path: ['units', i, 'releaseAt'],
            message: `unreadable date "${unit.releaseAt}" — use an ISO date like 2026-09-15`,
          });
        }
      }
    }

    if (!createsCourse) return;

    const typeNames = new Set(packet.itemTypes.map((t) => t.name.toLowerCase()));
    for (const gate of packet.course.gateTypes ?? []) {
      if (!typeNames.has(gate.toLowerCase())) {
        ctx.addIssue({
          code: 'custom',
          path: ['course', 'gateTypes'],
          message: `gateTypes references unknown item type "${gate}"`,
        });
      }
    }

    const dupType = findDuplicate(packet.itemTypes.map((t) => t.name));
    if (dupType) {
      ctx.addIssue({
        code: 'custom',
        path: ['itemTypes'],
        message: `duplicate item type name "${dupType}"`,
      });
    }
    for (const [i, t] of packet.itemTypes.entries()) {
      const dupField = findDuplicate(t.fields.map((f) => f.name));
      if (dupField) {
        ctx.addIssue({
          code: 'custom',
          path: ['itemTypes', i, 'fields'],
          message: `duplicate field name "${dupField}" in type "${t.name}"`,
        });
      }
      const dupTpl = findDuplicate(t.templates.map((tpl) => tpl.name));
      if (dupTpl) {
        ctx.addIssue({
          code: 'custom',
          path: ['itemTypes', i, 'templates'],
          message: `duplicate template name "${dupTpl}" in type "${t.name}"`,
        });
      }
    }
  });
export type Packet = z.infer<typeof packetSchema>;

/** Parse unknown JSON into a packet, throwing a readable error on failure. */
export function parsePacket(raw: unknown): Packet {
  const res = packetSchema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Not a valid srs-packet: ${issues}`);
  }
  return res.data;
}
