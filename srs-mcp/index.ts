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
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { packetSchema, PACKET_FORMAT, PACKET_VERSION } from '../src/packages/schema';

const EXCHANGE_DIR = process.env.SRS_EXCHANGE ?? path.join(os.homedir(), 'srs-exchange');
const INBOX_DIR = path.join(EXCHANGE_DIR, 'inbox');

const CONNECT_HELP = `No snapshot.json found in ${EXCHANGE_DIR}. In the SRS app, open Inbox → "Connect exchange folder" and pick exactly this folder (create it first if needed). The app then writes snapshot.json and imports packets from inbox/. To use a different folder, set the SRS_EXCHANGE environment variable for this MCP server.`;

interface SnapshotCourse {
  id: string;
  name: string;
  description: string;
  itemTypes: {
    name: string;
    fields: { name: string; kind: string }[];
    templates: { name: string; promptFields: string[]; answerField: string }[];
  }[];
  counts: Record<string, number>;
  items: { preview: string; type: string; fields: Record<string, string>; lapses: number; note?: string }[];
  struggling: { preview: string; fields: Record<string, string>; lapses: number; note?: string }[];
  ladder: { name: string } | null;
}

async function readSnapshot(): Promise<{ generatedAt: number; courses: SnapshotCourse[] }> {
  const raw = await fs.readFile(path.join(EXCHANGE_DIR, 'snapshot.json'), 'utf8').catch(() => {
    throw new Error(CONNECT_HELP);
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'snapshot.json exists but is not valid JSON — reopen the SRS app Inbox page to rewrite it.',
    );
  }
  const snap = parsed as { generatedAt?: unknown; courses?: unknown };
  if (typeof snap.generatedAt !== 'number' || !Array.isArray(snap.courses)) {
    throw new Error(
      'snapshot.json has an unexpected shape (older app version?) — reopen the SRS app Inbox page to rewrite it.',
    );
  }
  return parsed as { generatedAt: number; courses: SnapshotCourse[] };
}

function snapshotAge(snap: { generatedAt: number }): string {
  const mins = Math.round((Date.now() - snap.generatedAt) / 60_000);
  return `snapshot is ${mins} min old — it refreshes whenever the app's Inbox page is open`;
}

function findCourse(snap: { courses: SnapshotCourse[] }, ref: string): SnapshotCourse {
  const course =
    snap.courses.find((c) => c.id === ref) ??
    snap.courses.find((c) => c.name.toLowerCase() === ref.toLowerCase());
  if (!course) {
    throw new Error(
      `Course "${ref}" not found. Available: ${snap.courses.map((c) => `${c.name} (${c.id})`).join(', ') || 'none'}`,
    );
  }
  return course;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
function fail(err: unknown) {
  return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true };
}

async function writePacket(slugBase: string, packet: unknown): Promise<string> {
  const parsed = packetSchema.safeParse(packet);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Packet failed validation — fix the input and retry: ${issues}`);
  }
  await fs.mkdir(path.join(INBOX_DIR, 'done'), { recursive: true });
  const slug = slugBase.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'packet';
  const fileName = `${Date.now()}-${slug}.json`;
  await fs.writeFile(path.join(INBOX_DIR, fileName), JSON.stringify(packet, null, 2), 'utf8');
  return fileName;
}

const itemInput = z.object({
  fields: z
    .record(z.string(), z.string())
    .describe('Field NAME → value, using the exact field names of the item type'),
  key: z
    .string()
    .optional()
    .describe('Local handle so LATER items in this list can name this one as a prerequisite'),
  prereqs: z
    .array(z.string())
    .optional()
    .describe(
      'Keys of items defined EARLIER in this list (or existing item ids). The item stays locked until all of them are learned to the pass stage — use for radical→kanji→vocab style chains.',
    ),
  level: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Level number when the course uses levels (default 1)'),
  synonyms: z
    .union([z.array(z.string()), z.record(z.string(), z.array(z.string()))])
    .optional()
    .describe(
      'Alternate accepted answers. Plain array ONLY for single-template types; for multi-template types use {"templateName": ["synonym", ...]} so a meaning synonym never counts as a reading answer.',
    ),
  note: z.string().optional().describe('A short mnemonic shown during lessons and after misses'),
});

const server = new McpServer({ name: 'srs', version: '0.1.0' });

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
        return `• ${c.name} (id ${c.id})\n  ${c.description || 'no description'}\n  items: ${c.counts.items}, lesson queue: ${c.counts.lessonQueue}, due now: ${c.counts.dueNow}, ladder: ${c.ladder?.name ?? 'FSRS'}\n  ${types}`;
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
  'Create a whole new SRS course. Design an item type (2-4 fields), 1-2 quiz templates (prompt fields shown → answer field the user TYPES; keep answers 1-4 short typeable words), and the items. The packet lands in the app Inbox for one-click import.',
  {
    name: z.string().describe('Course name'),
    description: z.string().optional(),
    ladderPreset: z
      .enum(['classic', 'gentle', 'bunpro'])
      .optional()
      .describe('SRS ladder: classic (WaniKani 4h→4mo, burns), gentle (daily-life, never burns), bunpro (gradual 11 stages). Default classic.'),
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
    itemType: z.object({
      name: z.string().describe('Singular noun, e.g. "Word", "Fact"'),
      icon: z.string().optional().describe('One emoji'),
      fields: z.array(z.string()).min(1).describe('Field names, 2-4'),
      templates: z
        .array(
          z.object({
            name: z.string(),
            promptFields: z.array(z.string()).min(1),
            answerField: z.string(),
            answerLang: z
              .enum(['latin', 'kana'])
              .optional()
              .describe('kana = answer typed in Japanese kana, exact match'),
          }),
        )
        .min(1),
    }),
    items: z.array(itemInput).min(1),
  },
  async ({ name, description, ladderPreset, levelMode, gateTypes, passPercent, itemType, items }) => {
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
            fields: itemType.fields.map((f) => ({ name: f })),
            templates: itemType.templates.map((t) => ({
              name: t.name,
              promptFields: t.promptFields,
              answerField: t.answerField,
              answerLang: t.answerLang,
            })),
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
  'add_items',
  'Add items to an EXISTING course. Call get_course first to copy its exact field names and check for duplicates. The packet lands in the app Inbox for one-click import.',
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
