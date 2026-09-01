import { db } from '@/db/db';
import { isClozeSentences } from '@/engine/grading/cloze';
import type { Item } from '@/engine/types';
import type { CreateCoursePacket, PacketItem } from './schema';
import { PACKET_FORMAT, PACKET_VERSION } from './schema';

/**
 * Dependency order, then level, then creation time. The packet format requires
 * a prerequisite to appear before the items that reference it, so emitting in
 * plain creation order would produce an unimportable file for edited graphs.
 */
function topoSort(items: Item[]): Item[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const ordered: Item[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (item: Item) => {
    const s = state.get(item.id);
    if (s === 'done' || s === 'visiting') return; // 'visiting' ⇒ cycle: break it
    state.set(item.id, 'visiting');
    for (const pid of item.prereqIds) {
      const prereq = byId.get(pid);
      if (prereq) visit(prereq);
    }
    state.set(item.id, 'done');
    ordered.push(item);
  };
  for (const item of [...items].sort((a, b) => a.level - b.level || a.createdAt - b.createdAt)) {
    visit(item);
  }
  return ordered;
}

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

  const exportedIds = new Set(items.map((i) => i.id));
  const packetItems: PacketItem[] = topoSort(items)
    .map((item) => {
      const itemType = types.find((t) => t.id === item.typeId);
      if (!itemType) return null;
      const fields: PacketItem['fields'] = {};
      for (const f of itemType.fields) {
        // media values are local ids — meaningless in a shared packet
        if (f.kind === 'image' || f.kind === 'audio') continue;
        const v = item.fieldValues[f.id];
        if (typeof v === 'string' && v) fields[f.name] = v;
        else if (isClozeSentences(v)) fields[f.name] = v;
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
      // only edges to items in THIS packet — a reference to anything else
      // would fail the packet's own "defined earlier" validation on import
      const prereqs = item.prereqIds.filter((id) => exportedIds.has(id));
      return {
        type: itemType.name,
        // stable handle so prereq edges survive the round trip
        key: item.id,
        ...(prereqs.length > 0 ? { prereqs } : {}),
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
      ...(course.levelMode === 'levels'
        ? {
            levelMode: 'levels' as const,
            gateTypes: (course.levelConfig?.gateTypeIds ?? [])
              .map((id) => types.find((t) => t.id === id)?.name)
              .filter((n): n is string => !!n),
            passPercent: course.levelConfig?.passPercent,
            autoAdvance: course.levelConfig?.autoAdvance,
          }
        : {}),
    },
    itemTypes: types.map((t) => ({
      name: t.name,
      icon: t.icon,
      color: t.color,
      // media fields still get declared (as empty text) so templates that
      // prompt on them keep resolving — only their local ids are dropped
      fields: t.fields.map((f) => ({
        name: f.name,
        kind:
          f.kind === 'list'
            ? ('list' as const)
            : f.kind === 'clozeSentences'
              ? ('clozeSentences' as const)
              : ('text' as const),
      })),
      templates: t.templates.map((tpl) => ({
        name: tpl.name,
        promptFields: tpl.promptFieldIds.map(
          (id) => t.fields.find((f) => f.id === id)?.name ?? id,
        ),
        answerField: t.fields.find((f) => f.id === tpl.answerFieldId)?.name ?? tpl.answerFieldId,
        mode: tpl.grading.mode === 'choice' ? ('choice' as const) : undefined,
        choices: tpl.grading.mode === 'choice' ? tpl.grading.choices : undefined,
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
