import { assertItemContent, assertValidItemType } from '@/engine/contentValidation';
import { LADDER_PRESETS } from '@/engine/scheduler/presets';
import { localDayKey } from '@/engine/time';
import { backupSchema, type DecodedBackup } from './backupSchema';
export { backupSchema } from './backupSchema';

function indexed<T extends { id: string }>(rows: T[], table: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    if (map.has(row.id)) throw new Error(`Backup rejected: duplicate ${table} id "${row.id}"`);
    map.set(row.id, row);
  }
  return map;
}

/** Live references are strict; historical missing owners never regain mutation authority. */
export function decodeBackup(raw: unknown): DecodedBackup {
  const parsed = backupSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `Backup rejected: ${parsed.error.issues
        .slice(0, 6)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join(' · ')}`,
    );
  const backup = parsed.data;
  const data = backup.data;
  const courses = indexed(data.courses, 'course');
  const types = indexed(data.itemTypes, 'item type');
  const items = indexed(data.items, 'item');
  const cards = indexed(data.cards, 'card');
  const ladders = indexed(data.ladders, 'ladder');
  const plans = indexed(data.plans, 'plan');
  const mediaById = indexed(data.media, 'media');
  const logs = indexed(data.reviewLogs, 'review log');
  indexed(data.proposals, 'proposal');
  indexed(data.captures, 'capture');
  indexed(data.packetReceipts, 'packet receipt');
  indexed(data.cardTombstones, 'card tombstone');
  const dailyLessons = indexed(data.dailyLessons, 'daily lessons');
  if (new Set(data.meta.map((row) => row.key)).size !== data.meta.length)
    throw new Error('Backup rejected: duplicate metadata key');
  const check = (valid: unknown, message: string) => {
    if (!valid) throw new Error(`Backup rejected: ${message}`);
  };
  check(
    backup.formatVersion !== 1 ||
      (data.cardTombstones.length === 0 &&
        data.packetReceipts.length === 0 &&
        data.dailyLessons.length === 0),
    'format 1 cannot carry versioned tombstones, packet receipts or lesson ledgers',
  );
  if (backup.formatVersion === 1) {
    for (const log of data.reviewLogs) {
      if (log.kind !== 'lesson' || !courses.has(log.courseId)) continue;
      const day = localDayKey(log.ts);
      const id = `${log.courseId}:${day}`;
      const row = dailyLessons.get(id) ?? { id, day, courseId: log.courseId, itemIds: [] };
      if (!row.itemIds.includes(log.itemId)) row.itemIds.push(log.itemId);
      dailyLessons.set(id, row);
    }
    data.dailyLessons = [...dailyLessons.values()];
  }
  for (const row of data.dailyLessons) {
    check(
      courses.has(row.courseId) && row.id === `${row.courseId}:${row.day}`,
      `lesson ledger ${row.id} has invalid ownership or day identity`,
    );
    // Consumed items may have been deleted; their daily allowance stays consumed.
    row.itemIds = [...new Set(row.itemIds)];
  }
  const presets = new Map(LADDER_PRESETS.map((preset) => [preset.id, preset]));
  for (const preset of LADDER_PRESETS) {
    const imported = ladders.get(preset.id);
    check(
      !imported ||
        (imported.isPreset &&
          imported.courseId === null &&
          imported.burnEnabled === preset.burnEnabled &&
          imported.passesAtIndex === preset.passesAtIndex &&
          JSON.stringify(imported.stages) === JSON.stringify(preset.stages)),
      `built-in ladder ${preset.id} was modified; copy it to a course before editing`,
    );
    ladders.set(preset.id, { ...preset });
  }
  for (const row of data.ladders) {
    check(row.passesAtIndex <= row.stages.length, `ladder ${row.id} has an invalid pass stage`);
    check(
      new Set(row.stages.map((entry) => entry.id)).size === row.stages.length,
      `ladder ${row.id} has duplicate stages`,
    );
    check(
      row.isPreset
        ? row.courseId === null && presets.has(row.id)
        : row.courseId !== null && courses.has(row.courseId),
      `ladder ${row.id} has no owning course or known preset`,
    );
  }
  for (const row of data.courses) {
    const owned = ladders.get(row.scheduling.ladderId);
    check(
      owned && (owned.isPreset || owned.courseId === row.id),
      `course ${row.id} references a missing or foreign ladder`,
    );
    for (const gateId of row.levelConfig?.gateTypeIds ?? [])
      check(
        types.get(gateId)?.courseId === row.id,
        `course ${row.id} references a missing or foreign gate type`,
      );
  }
  for (const row of data.itemTypes) {
    check(courses.has(row.courseId), `item type ${row.id} has no course`);
    try {
      assertValidItemType(row, data.itemTypes);
    } catch (error) {
      throw new Error(
        `Backup rejected: item type ${row.id}: ${error instanceof Error ? error.message : 'invalid type'}`,
      );
    }
  }
  for (const row of data.items) {
    const owned = types.get(row.typeId);
    check(
      owned && owned.courseId === row.courseId && courses.has(row.courseId),
      `item ${row.id} references a missing or foreign type/course`,
    );
    if (!owned) continue;
    try {
      row.fieldValues = assertItemContent(row.fieldValues, owned);
    } catch (error) {
      throw new Error(
        `Backup rejected: item ${row.id}: ${error instanceof Error ? error.message : 'invalid content'}`,
      );
    }
    for (const key of [
      ...Object.keys(row.synonyms),
      ...Object.keys(row.blockList),
      ...Object.keys(row.guidance),
    ])
      check(
        owned.templates.some((entry) => entry.id === key),
        `item ${row.id} has an answer map for a missing template`,
      );
    for (const parent of row.prereqIds)
      check(
        parent !== row.id && items.get(parent)?.courseId === row.courseId,
        `item ${row.id} has a missing, foreign or self prerequisite`,
      );
    for (const field of owned.fields) {
      if (field.kind !== 'image' && field.kind !== 'audio') continue;
      const mediaId = row.fieldValues[field.id];
      if (typeof mediaId !== 'string' || !mediaId) continue;
      check(
        mediaById.get(mediaId)?.mimeType.startsWith(`${field.kind}/`),
        `item ${row.id} references missing or incompatible media ${mediaId}`,
      );
    }
  }
  // Iterative topological validation avoids overflowing on a large imported DAG.
  const remaining = new Map(data.items.map((row) => [row.id, new Set(row.prereqIds).size]));
  const children = new Map<string, string[]>();
  for (const row of data.items) {
    for (const parent of new Set(row.prereqIds)) {
      const dependents = children.get(parent) ?? [];
      dependents.push(row.id);
      children.set(parent, dependents);
    }
  }
  const ready = [...remaining].filter(([, number]) => number === 0).map(([key]) => key);
  let visited = 0;
  for (let cursor = 0; cursor < ready.length; cursor++) {
    visited++;
    for (const child of children.get(ready[cursor]) ?? []) {
      const next = remaining.get(child)! - 1;
      remaining.set(child, next);
      if (!next) ready.push(child);
    }
  }
  check(visited === items.size, 'prerequisite graph contains a cycle');
  const realPairs = new Set<string>();
  for (const row of data.cards) {
    const owner = items.get(row.itemId);
    const owned = owner ? types.get(owner.typeId) : undefined;
    check(
      owner &&
        owner.courseId === row.courseId &&
        owned?.templates.some((entry) => entry.id === row.templateId),
      `card ${row.id} references a missing or foreign item/template`,
    );
    const course = courses.get(row.courseId);
    const schedule = ladders.get(
      row.isGhost ? 'preset-ghost' : (course?.scheduling.ladderId ?? ''),
    );
    check(
      !row.srs ||
        (schedule &&
          row.srs.stageIndex <= schedule.stages.length &&
          (row.state !== 'review' || row.srs.stageIndex < schedule.stages.length)),
      `card ${row.id} has an invalid stage`,
    );
    if (row.isGhost) {
      const parent = cards.get(row.parentCardId ?? '');
      check(
        parent &&
          !parent.isGhost &&
          parent.itemId === row.itemId &&
          parent.templateId === row.templateId,
        `ghost ${row.id} has no matching parent`,
      );
    } else {
      const key = JSON.stringify([row.itemId, row.templateId]);
      check(!realPairs.has(key), `item ${row.itemId} has duplicate template cards`);
      realPairs.add(key);
    }
  }
  for (const row of data.items)
    for (const template of types.get(row.typeId)!.templates)
      check(
        realPairs.has(JSON.stringify([row.id, template.id])),
        `item ${row.id} is missing a template card`,
      );
  const plannedCourses = new Set<string>();
  for (const row of data.plans) {
    check(
      courses.has(row.courseId) && !plannedCourses.has(row.courseId),
      `plan ${row.id} has a missing course or another plan`,
    );
    plannedCourses.add(row.courseId);
    const owner = courses.get(row.courseId)!;
    check(
      owner.levelMode === 'levels' &&
        (owner.levelConfig?.autoAdvance !== false) === (row.releaseMode === 'progress'),
      `plan ${row.id} disagrees with its course's release ownership`,
    );
    check(
      row.units.every((entry, index) => entry.level === index + 1),
      `plan ${row.id} units must be ordered levels 1 through N`,
    );
  }
  for (const row of data.proposals) {
    check(
      courses.has(row.courseId) &&
        (row.planId === null || plans.get(row.planId)?.courseId === row.courseId),
      `proposal ${row.id} references a missing or foreign course/plan`,
    );
    if (row.acceptedItemId && items.has(row.acceptedItemId))
      check(
        items.get(row.acceptedItemId)?.courseId === row.courseId,
        `proposal ${row.id} references another course's item`,
      );
  }
  for (const row of data.cardTombstones) {
    const owner = items.get(row.itemId);
    check(
      !cards.has(row.id) &&
        owner?.courseId === row.courseId &&
        types.get(owner.typeId)?.templates.some((entry) => entry.id === row.templateId),
      `card tombstone ${row.id} has invalid ownership`,
    );
    const last = logs.get(row.logId);
    check(
      last?.cardId === row.id &&
        last.itemId === row.itemId &&
        last.courseId === row.courseId &&
        last.appliedRev === row.rev,
      `card tombstone ${row.id} has no matching latest log`,
    );
  }
  // Receipt course ids are delivery history and survive deletion of their content.
  // Restores preserve history, never an old tab's ability to undo a previous dataset.
  for (const row of data.reviewLogs) {
    const owner = items.get(row.itemId);
    const current = cards.get(row.cardId);
    if (owner && courses.has(row.courseId))
      check(
        owner.courseId === row.courseId && (!current || current.itemId === row.itemId),
        `review log ${row.id} has inconsistent ownership`,
      );
    delete row.appliedRev;
    delete row.itemRev;
    delete row.typeRev;
    delete row.appliedGeneration;
    delete row.itemGeneration;
    delete row.typeGeneration;
  }
  data.cardTombstones = [];
  return backup;
}
