import { db } from '@/db/db';
import { isClozeSentences } from '@/engine/grading/cloze';
import type { Item } from '@/engine/types';
import { downloadBlob } from '@/services/download';
import type { CreateCoursePacket, PacketItem } from './schema';
import { PACKET_FORMAT, PACKET_VERSION, parsePacket } from './schema';
import { blobToBase64 } from '@/db/blobCodec';
import { newId } from '@/engine/ids';

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
    if (s === 'done') return;
    if (s === 'visiting')
      throw new Error('The course has cyclic prerequisites. Repair them before exporting.');
    state.set(item.id, 'visiting');
    for (const pid of item.prereqIds) {
      const prereq = byId.get(pid);
      if (!prereq)
        throw new Error(
          'The course references a missing prerequisite. Repair it before exporting.',
        );
      visit(prereq);
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
  const { course, types, items, ladder, plan, media } = await db.transaction(
    'r',
    [db.courses, db.itemTypes, db.items, db.ladders, db.plans, db.media],
    async () => {
      const course = await db.courses.get(courseId);
      if (!course) throw new Error(`course not found: ${courseId}`);
      if (course.answerStyle !== 'perTemplate')
        throw new Error(
          'This course uses an unsupported answer style. Choose per-template answers before exporting.',
        );
      const types = (await db.itemTypes.where('courseId').equals(courseId).toArray()).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      if (
        types.some((type) =>
          type.templates.some((template) => ['self', 'cloze'].includes(template.grading.mode)),
        )
      )
        throw new Error(
          'This course has an unsupported grading mode. Repair its templates before exporting.',
        );
      const items = await db.items.where('courseId').equals(courseId).toArray();
      const ladder =
        course.scheduling.kind === 'ladder'
          ? await db.ladders.get(course.scheduling.ladderId)
          : undefined;
      if (!ladder) throw new Error('This course has an unsupported or missing scheduler.');
      const plan = await db.plans.where('courseId').equals(courseId).first();
      const mediaIds = new Set<string>();
      for (const item of items) {
        const type = types.find((candidate) => candidate.id === item.typeId);
        if (!type) throw new Error('An item has a missing type. Repair it before exporting.');
        for (const field of type.fields) {
          const value = item.fieldValues[field.id];
          if (
            (field.kind === 'image' || field.kind === 'audio') &&
            typeof value === 'string' &&
            value
          )
            mediaIds.add(value);
        }
      }
      const media = await db.media.bulkGet([...mediaIds]);
      if (media.some((asset) => !asset))
        throw new Error('A media attachment is missing. Attach it again before exporting.');
      return {
        course,
        types,
        items,
        ladder,
        plan,
        media: media.filter((asset) => asset !== undefined),
      };
    },
  );
  // Encode the captured blobs after the read transaction closes.
  const assets = await Promise.all(
    media.map(async (asset) => ({
      key: asset.id,
      name: asset.name,
      mimeType: asset.mimeType,
      data: await blobToBase64(asset.blob),
    })),
  );

  const exportedIds = new Set(items.map((i) => i.id));
  const packetItems: PacketItem[] = topoSort(items)
    .map((item) => {
      const itemType = types.find((t) => t.id === item.typeId);
      if (!itemType) throw new Error('Missing item type.');
      const fields: PacketItem['fields'] = {};
      for (const f of itemType.fields) {
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
        blockList: Object.fromEntries(
          Object.entries(item.blockList).map(([id, value]) => [
            itemType.templates.find((template) => template.id === id)?.name ?? id,
            value,
          ]),
        ),
        guidance: Object.fromEntries(
          Object.entries(item.guidance).map(([id, value]) => [
            itemType.templates.find((template) => template.id === id)?.name ?? id,
            value,
          ]),
        ),
        ...(item.note ? { note: item.note } : {}),
        ...(item.level > 1 ? { level: item.level } : {}),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const packet: CreateCoursePacket = {
    format: PACKET_FORMAT,
    version: PACKET_VERSION,
    id: newId(),
    kind: 'create-course',
    course: {
      name: course.name,
      description: course.description || undefined,
      ghosts: course.ghosts,
      answerStyle: 'perTemplate',
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
      fields: t.fields.map((f) => ({ name: f.name, kind: f.kind })),
      templates: t.templates.map((tpl) => ({
        name: tpl.name,
        promptFields: tpl.promptFieldIds.map((id) => t.fields.find((f) => f.id === id)?.name ?? id),
        answerField: t.fields.find((f) => f.id === tpl.answerFieldId)?.name ?? tpl.answerFieldId,
        mode:
          tpl.grading.mode === 'sentenceCloze'
            ? 'sentenceCloze'
            : tpl.grading.mode === 'choice'
              ? 'choice'
              : 'typed',
        rotation: tpl.grading.mode === 'sentenceCloze' ? tpl.grading.rotation : undefined,
        hintFields: tpl.hintFieldIds.map((id) => t.fields.find((f) => f.id === id)?.name ?? id),
        choices: tpl.grading.mode === 'choice' ? tpl.grading.choices : undefined,
        answerLang: tpl.grading.mode === 'typed' ? tpl.grading.answerLang : undefined,
        typoTolerance: tpl.grading.mode === 'typed' ? tpl.grading.typoTolerance : undefined,
      })),
    })),
    items: packetItems,
    ladder: {
      name: ladder.name,
      stages: ladder.stages.map((stage) => ({
        name: stage.name,
        intervalMinutes: stage.intervalMinutes,
      })),
      passesAtIndex: ladder.passesAtIndex,
      burnEnabled: ladder.burnEnabled,
    },
    media: assets,
    ...(plan
      ? {
          plan: {
            title: plan.title,
            material: plan.material,
            materialTruncated: plan.materialTruncated,
            releaseMode: plan.releaseMode,
            units: plan.units.map(({ level: _level, generatedAt: _generatedAt, ...unit }) => unit),
          },
        }
      : {}),
  };
  return parsePacket(packet) as CreateCoursePacket;
}

export function downloadPackage(packet: CreateCoursePacket): void {
  downloadBlob(
    new Blob([JSON.stringify(packet, null, 2)], { type: 'application/json' }),
    `${packet.course.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.srs-course.json`,
  );
}
