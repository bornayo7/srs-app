import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parsePacket } from '../src/packages/schema';
import { snapshotSchema, type Snapshot, type SnapshotCourse } from '../src/exchange/snapshotSchema';

export async function readSnapshot(directory: string): Promise<Snapshot> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(directory, 'snapshot.json'), 'utf8');
  } catch {
    throw new Error(
      `No readable snapshot.json in ${directory}. Connect this exact exchange folder from the app's Inbox, then refresh it.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('snapshot.json is not valid JSON. Refresh it from the app Inbox.');
  }
  const result = snapshotSchema.safeParse(parsed);
  if (!result.success)
    throw new Error(
      `snapshot.json is invalid (${result.error.issues[0].path.join('.')}). Refresh it from the app Inbox.`,
    );
  return result.data;
}

export function findCourse(snapshot: Pick<Snapshot, 'courses'>, ref: string): SnapshotCourse {
  const byId = snapshot.courses.find((course) => course.id === ref);
  if (byId) return byId;
  const matches = snapshot.courses.filter(
    (course) => course.name.toLowerCase() === ref.toLowerCase(),
  );
  if (matches.length > 1) throw new Error(`Several courses are named "${ref}". Use the course id.`);
  if (!matches[0])
    throw new Error(
      `Course "${ref}" not found. Available: ${snapshot.courses.map((course) => `${course.name} (${course.id})`).join(', ') || 'none'}`,
    );
  return matches[0];
}

/** The final .json name is linked only after every byte is flushed and closed. */
export async function writePacket(
  directory: string,
  slugBase: string,
  raw: unknown,
): Promise<string> {
  const packet = { ...parsePacket(raw), id: randomUUID() };
  const inbox = path.join(directory, 'inbox');
  await fs.mkdir(path.join(inbox, 'done'), { recursive: true });
  const slug =
    slugBase
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40) || 'packet';
  const filename = `${Date.now()}-${slug}-${packet.id}.json`;
  const temporary = path.join(inbox, `.${packet.id}.tmp`);
  const file = await fs.open(temporary, 'wx');
  try {
    try {
      await file.writeFile(JSON.stringify(packet, null, 2), 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.link(temporary, path.join(inbox, filename));
  } finally {
    // A hidden scratch-file cleanup failure cannot turn a published delivery
    // into an apparent failure and invite a second packet with a fresh ID.
    await fs.unlink(temporary).catch(() => {});
  }
  return filename;
}
