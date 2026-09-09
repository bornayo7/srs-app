/**
 * srs-mcp — stdio MCP server for the SRS app.
 *
 * Bridges AI assistants (Claude, ChatGPT, Hermes, any MCP client) to the
 * local-first SRS app through an exchange folder:
 *   <exchange>/snapshot.json  — read here; written by the app (Inbox page)
 *   <exchange>/inbox/*.json   — packets written here; imported in the app
 *
 * Run: `npx tsx index.ts`  (SRS_EXCHANGE env overrides the folder,
 * default ~/srs-exchange)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import os from 'node:os';
import {
  packetItemSchema,
  packetItemTypeSchema,
  packetUnitSchema,
  PACKET_FORMAT,
  PACKET_VERSION,
} from '../src/packages/schema';
import {
  readSnapshot as readExchangeSnapshot,
  writePacket as publishPacket,
  findCourse,
} from './exchangeFiles';

const EXCHANGE_DIR = process.env.SRS_EXCHANGE ?? path.join(os.homedir(), 'srs-exchange');
const readSnapshot = () => readExchangeSnapshot(EXCHANGE_DIR);
const writePacket = (slug: string, packet: unknown) => publishPacket(EXCHANGE_DIR, slug, packet);

function snapshotAge(snap: { generatedAt: number }): string {
  const mins = Math.round((Date.now() - snap.generatedAt) / 60_000);
  return `snapshot is ${mins} min old — it refreshes whenever the app's Inbox page is open`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
function fail(err: unknown) {
  return {
    content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
    isError: true,
  };
}

const itemInput = packetItemSchema;
const itemTypeInput = packetItemTypeSchema.extend({
  fields: z.array(z.union([z.string().min(1), packetItemTypeSchema.shape.fields.element])).min(1),
});
const unitInput = packetUnitSchema;
const toFields = (fields: z.infer<typeof itemTypeInput>['fields']) =>
  fields.map((field) => (typeof field === 'string' ? { name: field } : field));

const server = new McpServer({ name: 'srs', version: '0.2.0' });

server.tool(
  'list_courses',
  "List the user's SRS courses with item counts, due counts, and their item-type schemas. Call this first to learn what exists and what field names each course uses.",
  {},
  async () => {
    try {
      const snap = await readSnapshot();
      if (snap.courses.length === 0) return ok(`No courses yet. (${snapshotAge(snap)})`);
      const lines = snap.courses.map((c) => {
        const types = c.itemTypes
          .map(
            (t) =>
              `${t.name}[${t.fields.map((f) => f.name).join(', ')}] templates: ${t.templates
                .map((tpl) => `${tpl.name}(${tpl.promptFields.join('+')}→${tpl.answerField})`)
                .join(', ')}`,
          )
          .join(' | ');
        const plan = c.plan
          ? `\n  PLAN (${c.plan.releaseMode} release): ${c.plan.units
              .map(
                (u) =>
                  `unit ${u.level} "${u.title}"${u.released ? ' [open]' : u.releaseAt ? ` [opens ${u.releaseAt}]` : ' [locked]'}${u.pendingProposals ? ` (${u.pendingProposals} awaiting review)` : ''}`,
              )
              .join(', ')} — propose items with propose_items(unit=N)`
          : '';
        return `• ${c.name} (id ${c.id})\n  ${c.description || 'no description'}\n  items: ${c.counts.items}, lesson queue: ${c.counts.lessonQueue}, due now: ${c.counts.dueNow}, ladder: ${c.ladder?.name ?? 'FSRS'}\n  ${types}${plan}`;
      });
      return ok(`${lines.join('\n')}\n\n(${snapshotAge(snap)})`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  'get_course',
  'Full detail for one course: item-type schemas plus every item (preview, field values, lapse counts, notes). Use before add_items to match field names and avoid duplicates.',
  { course: z.string().describe('Course id or exact course name') },
  async ({ course: ref }) => {
    try {
      const snap = await readSnapshot();
      const course = findCourse(snap, ref);
      return ok(JSON.stringify(course, null, 1));
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  'get_struggling_items',
  "Items the user keeps failing (leeches), most-failed first. Useful for 'write me better mnemonics for what I keep missing'.",
  { course: z.string().describe('Course id or exact course name') },
  async ({ course: ref }) => {
    try {
      const snap = await readSnapshot();
      const course = findCourse(snap, ref);
      if (course.struggling.length === 0) {
        return ok(`No struggling items in "${course.name}" — nothing failed repeatedly yet.`);
      }
      const lines = course.struggling.map(
        (i) =>
          `• ${i.preview} — ${i.lapses} misses. Fields: ${JSON.stringify(i.fields)}${i.note ? ` Current note: ${i.note}` : ''}`,
      );
      return ok(lines.join('\n'));
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  'create_course',
  'Create a whole new SRS course, imported as-is. Design an item type (2-4 fields), 1-2 quiz templates (prompt fields shown → answer field the user answers; keep typed answers 1-4 short typeable words, or set mode "choice" for multiple choice), and the items. The packet lands in the app Inbox for one-click import. For a course built from a syllabus or notes that should unlock unit by unit with per-item approval, use propose_course_plan instead.',
  {
    name: z.string().describe('Course name'),
    description: z.string().optional(),
    ladderPreset: z
      .enum(['classic', 'gentle', 'bunpro'])
      .optional()
      .describe(
        'SRS ladder: classic (WaniKani 4h→4mo, burns), gentle (daily-life, never burns), bunpro (gradual 11 stages). Default classic.',
      ),
    levelMode: z
      .enum(['flat', 'levels'])
      .optional()
      .describe('"levels" gates content behind level-ups (WaniKani style); default "flat".'),
    gateTypes: z
      .array(z.string())
      .optional()
      .describe('Item type NAMES whose passing drives level-ups (default: all types).'),
    passPercent: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Percent of a level’s gate items that must pass to advance (default 90).'),
    itemType: itemTypeInput,
    items: z.array(itemInput).min(1),
  },
  async ({
    name,
    description,
    ladderPreset,
    levelMode,
    gateTypes,
    passPercent,
    itemType,
    items,
  }) => {
    try {
      // proves the user has actually connected the exchange folder — otherwise
      // the packet would land somewhere the app never reads
      await readSnapshot();
      const packet = {
        format: PACKET_FORMAT,
        version: PACKET_VERSION,
        kind: 'create-course',
        course: { name, description, ladderPreset, levelMode, gateTypes, passPercent },
        itemTypes: [
          {
            name: itemType.name,
            icon: itemType.icon,
            fields: toFields(itemType.fields),
            templates: itemType.templates,
          },
        ],
        items,
      };
      const fileName = await writePacket(`create-${name}`, packet);
      return ok(
        `Packet written: inbox/${fileName} — course "${name}" with ${items.length} item(s). Tell the user to open the SRS app → Inbox and click Import (the page also rescans on focus).`,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  'propose_course_plan',
  'Create a PROGRESSIVE course from the user’s own course material (a syllabus, lecture notes, chapters): ordered UNITS that open one at a time (unit N = level N), 1-3 item types, and optionally proposed items per unit. Every proposed item goes to a review queue in the app where the user accepts, edits, or rejects it — nothing enters their reviews unapproved. Use this instead of create_course whenever the user wants content to arrive as the course progresses. Include the material itself so the app can draft later units from it.',
  {
    name: z.string().describe('Course name'),
    description: z.string().optional(),
    ladderPreset: z
      .enum(['classic', 'gentle', 'bunpro'])
      .optional()
      .describe(
        'SRS ladder: classic (WaniKani 4h→4mo, burns), gentle (never burns), bunpro (gradual). Default classic.',
      ),
    releaseMode: z
      .enum(['progress', 'schedule', 'manual'])
      .optional()
      .describe(
        'How units open: progress (default) = when enough of the current unit reaches the pass stage; schedule = on each unit’s releaseAt date; manual = only when the user presses "Release next unit".',
      ),
    passPercent: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'progress mode: percent of a unit’s items that must pass to open the next (default 90)',
      ),
    newPerDay: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Daily new-lesson cap — the within-unit drip (default 15)'),
    itemTypes: z.array(itemTypeInput).min(1).max(3),
    units: z
      .array(unitInput)
      .min(1)
      .describe(
        'In course order. Author items in dependency order across units — a prereq key must be defined earlier.',
      ),
    material: z
      .string()
      .optional()
      .describe(
        'The source material in full (syllabus / notes). Saved with the plan so later units can be drafted from it; never shown as a card.',
      ),
  },
  async ({
    name,
    description,
    ladderPreset,
    releaseMode,
    passPercent,
    newPerDay,
    itemTypes,
    units,
    material,
  }) => {
    try {
      await readSnapshot(); // proves the exchange folder is connected
      const packet = {
        format: PACKET_FORMAT,
        version: PACKET_VERSION,
        kind: 'course-plan',
        course: { name, description, ladderPreset, releaseMode, passPercent, newPerDay },
        itemTypes: itemTypes.map((t) => ({
          name: t.name,
          icon: t.icon,
          fields: toFields(t.fields),
          templates: t.templates,
        })),
        units,
        material,
      };
      const fileName = await writePacket(`plan-${name}`, packet);
      const proposed = units.reduce((n, u) => n + (u.items?.length ?? 0), 0);
      return ok(
        `Packet written: inbox/${fileName} — planned course "${name}" with ${units.length} unit(s) and ${proposed} proposed item(s). Tell the user to open the SRS app → Inbox → Import, then review the proposals on the course’s Plan page (Course page → "Open plan").`,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  'propose_items',
  'Propose items for an EXISTING course’s REVIEW QUEUE — the user accepts or rejects each one before it enters their reviews. Prefer this over add_items for anything drafted from course material. For planned courses, pass unit=N so the items enter that unit (level) and stay locked until it opens. Call get_course first for exact field names, existing items (avoid duplicates; their ids can be prerequisites), and the unit list.',
  {
    course: z.string().describe('Course id (preferred) or exact course name'),
    type: z
      .string()
      .optional()
      .describe('Item type name — required only when the course has multiple types'),
    unit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Target unit (= level) for items that don’t set their own level; default: the course’s current level',
      ),
    items: z.array(itemInput).min(1),
  },
  async ({ course: ref, type, unit, items }) => {
    try {
      const snap = await readSnapshot();
      const course = findCourse(snap, ref);
      const packet = {
        format: PACKET_FORMAT,
        version: PACKET_VERSION,
        kind: 'propose-items',
        courseId: course.id,
        courseName: course.name,
        unit,
        items: items.map((i) => (type ? { ...i, type } : i)),
      };
      const fileName = await writePacket(`propose-${course.name}`, packet);
      return ok(
        `Packet written: inbox/${fileName} — ${items.length} item(s) proposed for "${course.name}"${unit ? ` (unit ${unit})` : ''}. Tell the user to open the SRS app → Inbox → Import, then accept or reject them on the course’s Plan page.`,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  'add_items',
  'Add items DIRECTLY to an EXISTING course (they enter the lesson queue on import, with no per-item review). For drafts the user should approve first, use propose_items instead. Call get_course first to copy its exact field names and check for duplicates. The packet lands in the app Inbox for one-click import.',
  {
    course: z.string().describe('Course id (preferred) or exact course name'),
    type: z
      .string()
      .optional()
      .describe('Item type name — required only when the course has multiple types'),
    items: z.array(itemInput).min(1),
  },
  async ({ course: ref, type, items }) => {
    try {
      // resolve against the snapshot so name→id happens here, not at import time
      const snap = await readSnapshot();
      const course = findCourse(snap, ref);
      const packet = {
        format: PACKET_FORMAT,
        version: PACKET_VERSION,
        kind: 'add-items',
        courseId: course.id,
        courseName: course.name,
        items: items.map((i) => (type ? { ...i, type } : i)),
      };
      const fileName = await writePacket(`add-${course.name}`, packet);
      return ok(
        `Packet written: inbox/${fileName} — ${items.length} item(s) for "${course.name}". Tell the user to open the SRS app → Inbox and click Import.`,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`srs-mcp ready — exchange folder: ${EXCHANGE_DIR}`);
