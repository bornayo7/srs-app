import { db } from '@/db/db';
import type { CreateCoursePacket, PacketItem } from './schema';
import { PACKET_FORMAT, PACKET_VERSION } from './schema';

/**
 * Export a course as a content-only create-course packet (no SRS state) —
 * for sharing, and as few-shot context for AI generation.
 */
export async function exportCoursePackage(courseId: string): Promise<CreateCoursePacket> {
  const course = await db.courses.get(courseId);
  if (!course) throw new Error(`course not found: ${courseId}`);
  const types = await db.itemTypes.where('courseId').equals(courseId).toArray();
  const items = await db.items.where('courseId').equals(courseId).toArray();
  const ladder =
    course.scheduling.kind === 'ladder' ? await db.ladders.get(course.scheduling.ladderId) : null;

  const ladderPreset = ladder?.name.toLowerCase().includes('gentle')
    ? ('gentle' as const)
    : ladder?.name.toLowerCase().includes('bunpro')
      ? ('bunpro' as const)
      : ('classic' as const);

  const packetItems: PacketItem[] = items
    .sort((a, b) => a.level - b.level || a.createdAt - b.createdAt)
    .map((item) => {
      const itemType = types.find((t) => t.id === item.typeId);
      if (!itemType) return null;
      const fields: Record<string, string | string[]> = {};
      for (const f of itemType.fields) {
        const v = item.fieldValues[f.id];
        if (typeof v === 'string' && v) fields[f.name] = v;
        else if (Array.isArray(v) && v.length && typeof v[0] === 'string') {
          fields[f.name] = v as string[];
        }
      }
      const synonymEntries = Object.entries(item.synonyms).filter(([, s]) => s.length > 0);
      const synonyms =
        synonymEntries.length === 0
          ? undefined
          : Object.fromEntries(
              synonymEntries.map(([tplId, syns]) => [
                itemType.templates.find((t) => t.id === tplId)?.name ?? tplId,
                syns,
              ]),
            );
      return {
        type: itemType.name,
        fields,
        ...(synonyms ? { synonyms } : {}),
        ...(item.note ? { note: item.note } : {}),
        ...(item.level > 1 ? { level: item.level } : {}),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return {
    format: PACKET_FORMAT,
    version: PACKET_VERSION,
    kind: 'create-course',
    course: {
      name: course.name,
      description: course.description || undefined,
      ladderPreset,
      newPerDay: course.lessons.newPerDay,
      batchSize: course.lessons.batchSize,
    },
    itemTypes: types.map((t) => ({
      name: t.name,
      icon: t.icon,
      color: t.color,
      fields: t.fields.map((f) => ({
        name: f.name,
        kind: f.kind === 'list' ? ('list' as const) : ('text' as const),
      })),
      templates: t.templates.map((tpl) => ({
        name: tpl.name,
        promptFields: tpl.promptFieldIds.map(
          (id) => t.fields.find((f) => f.id === id)?.name ?? id,
        ),
        answerField: t.fields.find((f) => f.id === tpl.answerFieldId)?.name ?? tpl.answerFieldId,
        answerLang: tpl.grading.mode === 'typed' ? tpl.grading.answerLang : undefined,
        typoTolerance: tpl.grading.mode === 'typed' ? tpl.grading.typoTolerance : undefined,
      })),
    })),
    items: packetItems,
  };
}

export function downloadPackage(packet: CreateCoursePacket): void {
  const blob = new Blob([JSON.stringify(packet, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${packet.course.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.srs-course.json`;
  a.click();
  URL.revokeObjectURL(url);
}
