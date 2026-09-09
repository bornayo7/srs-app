import type { CreateItemInput } from '@/db/repo/items';
import { findDuplicate } from '@/db/repo/proposals';
import { parseClozeLines } from '@/engine/grading/cloze';
import { assertItemContent } from '@/engine/contentValidation';
import type { FieldValue, Item, ItemType } from '@/engine/types';
import type { PacketItem } from './schema';

/** The single named-content adapter used by direct imports and the proposal queue. */
export function resolveItem(
  item: PacketItem,
  itemType: ItemType,
  index: number,
): Pick<CreateItemInput, 'fieldValues' | 'synonyms' | 'blockList' | 'guidance' | 'note' | 'level'> {
  const fieldByName = new Map(itemType.fields.map((f) => [f.name.toLowerCase(), f]));
  const fieldValues: Record<string, FieldValue> = {};

  for (const [name, value] of Object.entries(item.fields)) {
    const field = fieldByName.get(name.toLowerCase());
    if (!field) {
      const valid = itemType.fields.map((f) => `"${f.name}"`).join(', ');
      throw new Error(
        `Item ${index + 1}: unknown field "${name}" for type "${itemType.name}" (valid: ${valid})`,
      );
    }
    let normalized = value;
    if (typeof value === 'string' && field.kind === 'list') {
      normalized = value.split('\n').map((v) => v.trim()).filter(Boolean);
    }
    if (typeof value === 'string' && field.kind === 'clozeSentences') {
      const parsed = parseClozeLines(value);
      if (parsed.error) throw new Error(`Item ${index + 1}: ${field.name}: ${parsed.error}`);
      normalized = parsed.sentences;
    }
    if (field.id in fieldValues) throw new Error(`Item ${index + 1}: repeated field "${name}"`);
    fieldValues[field.id] = normalized;
  }

  const values = assertItemContent(fieldValues, itemType);

  const synonyms: Record<string, string[]> = {};
  if (Array.isArray(item.synonyms)) {
    const cleaned = item.synonyms.filter((s) => s.trim().length > 0);
    if (cleaned.length > 0) {
      if (itemType.templates.length > 1) {
        // Applying loose synonyms to every template would make e.g. a meaning
        // synonym an accepted READING answer, defeating wrong-facet grading.
        throw new Error(
          `Item ${index + 1}: type "${itemType.name}" has ${itemType.templates.length} templates — use the record form of synonyms ({"templateName": [...]}) instead of a plain array`,
        );
      }
      synonyms[itemType.templates[0].id] = cleaned;
    }
  } else if (item.synonyms) {
    const tplByName = new Map(itemType.templates.map((t) => [t.name.toLowerCase(), t]));
    for (const [tplName, syns] of Object.entries(item.synonyms)) {
      const tpl = tplByName.get(tplName.toLowerCase());
      if (!tpl) {
        throw new Error(`Item ${index + 1}: unknown template "${tplName}" in synonyms`);
      }
      if (tpl.id in synonyms) throw new Error(`Item ${index + 1}: repeated template "${tplName}" in synonyms`);
      synonyms[tpl.id] = syns;
    }
  }

  const templateMap = <T>(input: Record<string, T> | undefined): Record<string, T> => {
    const result: Record<string, T> = {};
    for (const [name, value] of Object.entries(input ?? {})) {
      const template = itemType.templates.find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (!template) throw new Error(`Item ${index + 1}: unknown template "${name}"`);
      if (template.id in result) throw new Error(`Item ${index + 1}: repeated template "${name}" in answer settings`);
      result[template.id] = value;
    }
    return result;
  };
  return { fieldValues: values, synonyms, blockList: templateMap(item.blockList), guidance: templateMap(item.guidance), note: item.note ?? '', level: item.level };
}

export function pickType(item: PacketItem, types: ItemType[], index: number): ItemType {
  if (!item.type) {
    if (types.length === 1) return types[0];
    throw new Error(
      `Item ${index + 1}: "type" is required — the course has ${types.length} item types`,
    );
  }
  const found = types.find((t) => t.name.toLowerCase() === item.type!.toLowerCase());
  if (!found) {
    throw new Error(
      `Item ${index + 1}: unknown item type "${item.type}" (valid: ${types.map((t) => t.name).join(', ')})`,
    );
  }
  return found;
}

/** Resolve one packet item against a course's types — throws with a precise message. */
export function resolvePacketItem(
  item: PacketItem,
  types: ItemType[],
  index = 0,
): { itemType: ItemType; resolved: Pick<CreateItemInput, 'fieldValues' | 'synonyms' | 'blockList' | 'guidance' | 'note' | 'level'> } {
  const itemType = pickType(item, types, index);
  return { itemType, resolved: resolveItem(item, itemType, index) };
}

/**
 * The review queue's per-row checks: a validation error (without the batch
 * index prefix — rows are reviewed one at a time) and a duplicate flag.
 */
export function dryRunProposal(
  item: PacketItem,
  types: ItemType[],
  existing: readonly Item[],
): { error: string | null; duplicateOf: string | null } {
  try {
    const { itemType } = resolvePacketItem(item, types);
    return { error: null, duplicateOf: findDuplicate(item, itemType, existing) };
  } catch (err) {
    return { error: (err as Error).message.replace(/^Item \d+: /, ''), duplicateOf: null };
  }
}
