import { z } from 'zod';

/**
 * The srs-packet format: one JSON shape, three producers — the MCP server,
 * in-app AI generation, and hand-written files — all validated here before
 * anything touches the database.
 *
 * NOTE: this file is also imported by srs-mcp (which may resolve zod v3), so
 * stick to zod syntax that is identical in v3 and v4: two-arg z.record,
 * z.discriminatedUnion, z.enum, .optional, .min.
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

export const createCoursePacketSchema = z.object({
  format: z.literal(PACKET_FORMAT),
  version: z.literal(PACKET_VERSION),
  kind: z.literal('create-course'),
  course: z.object({
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
  }),
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

// discriminatedUnion needs plain objects, so name-uniqueness refinement lives
// on the union. Names are lookup keys (resolved case-insensitively) —
// collisions would silently misroute data, so reject them at the boundary.
export const packetSchema = z
  .discriminatedUnion('kind', [createCoursePacketSchema, addItemsPacketSchema])
  .superRefine((packet, ctx) => {
    // Prereq handles: unique, and referenced only after they're defined.
    // "Earlier in the array" is required (and makes cycles impossible) —
    // author content in dependency order: radicals, then kanji, then vocab.
    const seenKeys = new Set<string>();
    for (const [i, item] of packet.items.entries()) {
      for (const ref of item.prereqs ?? []) {
        // add-items packets may also reference existing item ids — those are
        // resolved (and validated) at import time against the target course
        if (!seenKeys.has(ref) && packet.kind === 'create-course') {
          ctx.addIssue({
            code: 'custom',
            path: ['items', i, 'prereqs'],
            message: `unknown prerequisite "${ref}" — reference the "key" of an item defined earlier in this packet`,
          });
        }
      }
      if (item.key) {
        if (seenKeys.has(item.key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['items', i, 'key'],
            message: `duplicate item key "${item.key}"`,
          });
        }
        seenKeys.add(item.key);
      }
    }

    if (packet.kind !== 'create-course') return;

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
