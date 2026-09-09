import type { CardTemplate, FieldValue, Item, ItemType } from '../types';
import type { MatchContext } from './match';
import { richTextToPlain } from '../richtext';

function asStrings(v: FieldValue | undefined): string[] {
  if (v === undefined) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return [];
}

/** Assemble the grading context for one card from its item + type. Pure. */
export function buildMatchContext(
  item: Item,
  itemType: ItemType,
  template: CardTemplate,
): MatchContext {
  const answersFor = (fieldId: string) => {
    const answers = asStrings(item.fieldValues[fieldId]);
    return itemType.fields.find((f) => f.id === fieldId)?.kind === 'richtext'
      ? answers.map(richTextToPlain)
      : answers;
  };
  const accepted = [...answersFor(template.answerFieldId), ...(item.synonyms[template.id] ?? [])];

  const siblingAccepted = itemType.templates
    .filter((t) => t.id !== template.id)
    .flatMap((t) => [...answersFor(t.answerFieldId), ...(item.synonyms[t.id] ?? [])]);

  const grading =
    template.grading.mode === 'typed'
      ? template.grading
      : ({ mode: 'typed', answerLang: 'any', typoTolerance: true } as const);

  return {
    accepted,
    blocked: item.blockList[template.id] ?? [],
    guidance: item.guidance[template.id] ?? [],
    siblingAccepted,
    answerLang: grading.answerLang,
    typoTolerance: grading.typoTolerance,
  };
}

/** First text-ish field value — used as the item's display name in lists. */
export function itemPreview(item: Pick<Item, 'fieldValues'>, itemType: ItemType): string {
  for (const f of itemType.fields) {
    // image/audio values are media ids — showing one as a name is worse than nothing
    if (f.kind === 'image' || f.kind === 'audio') continue;
    const vals = asStrings(item.fieldValues[f.id]);
    if (vals.length > 0) return vals.join(', ');
  }
  const media = itemType.fields.find(
    (f) => (f.kind === 'image' || f.kind === 'audio') && item.fieldValues[f.id],
  );
  if (media) return media.kind === 'image' ? '🖼️ (image)' : '🔊 (audio)';
  return '(empty)';
}
