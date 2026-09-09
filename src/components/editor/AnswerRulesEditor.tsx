import { Button, Field, TextInput } from '@/components/ui';
import type { GuidanceAnswer, Item, ItemType } from '@/engine/types';
import { ListInput } from './ListInput';

type AnswerRules = Pick<Item, 'synonyms' | 'blockList' | 'guidance'>;
/** Edits authored answer exceptions; domain validation happens at the item save boundary. */
export function AnswerRulesEditor({
  draft,
  itemType,
  patch,
}: {
  draft: AnswerRules;
  itemType: ItemType;
  patch: (change: Partial<AnswerRules>) => void;
}) {
  const setTemplateList = (key: 'synonyms' | 'blockList', templateId: string, list: string[]) =>
    patch({ [key]: { ...draft[key], [templateId]: list } } as Partial<AnswerRules>);

  const setGuidance = (templateId: string, list: GuidanceAnswer[]) =>
    patch({ guidance: { ...draft.guidance, [templateId]: list } });

  return (
    <div className="space-y-5">
      {itemType.templates.map((tpl) => {
        const guidance = draft.guidance[tpl.id] ?? [];
        return (
          <section key={tpl.id} className="rounded-lg border border-slate-800 p-3">
            <h3 className="mb-2 text-sm font-semibold text-slate-200">{tpl.name}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Also accept (synonyms)"
                hint="Comma-separated. Graded exactly like the real answer."
              >
                <ListInput
                  value={draft.synonyms[tpl.id] ?? []}
                  onChange={(list) => setTemplateList('synonyms', tpl.id, list)}
                />
              </Field>
              <Field
                label="Never accept (block list)"
                hint="Beats typo tolerance — for near-misses that mean something else."
              >
                <ListInput
                  value={draft.blockList[tpl.id] ?? []}
                  onChange={(list) => setTemplateList('blockList', tpl.id, list)}
                />
              </Field>
            </div>

            <div className="mt-3">
              <div className="mb-1 text-xs text-slate-400">
                Guidance answers — retry with a nudge instead of a penalty
              </div>
              {guidance.map((g, i) => (
                <div key={i} className="mb-1.5 flex flex-wrap gap-2">
                  <TextInput
                    aria-label={`${tpl.name} guidance answer ${i + 1}`}
                    value={g.text}
                    placeholder="answer typed"
                    className="max-w-48"
                    onChange={(e) =>
                      setGuidance(
                        tpl.id,
                        guidance.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                      )
                    }
                  />
                  <TextInput
                    aria-label={`${tpl.name} guidance message ${i + 1}`}
                    value={g.message}
                    placeholder="Almost — we want the noun form"
                    onChange={(e) =>
                      setGuidance(
                        tpl.id,
                        guidance.map((x, j) => (j === i ? { ...x, message: e.target.value } : x)),
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    aria-label={`Remove ${tpl.name} guidance answer ${i + 1}`}
                    onClick={() =>
                      setGuidance(
                        tpl.id,
                        guidance.filter((_, j) => j !== i),
                      )
                    }
                  >
                    ✕
                  </Button>
                </div>
              ))}
              <Button onClick={() => setGuidance(tpl.id, [...guidance, { text: '', message: '' }])}>
                + Add guidance answer
              </Button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
