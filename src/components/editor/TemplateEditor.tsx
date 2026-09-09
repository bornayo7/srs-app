import { Button, Field, Select, TextInput } from '@/components/ui';
import {
  clampChoiceCount,
  DEFAULT_CHOICE_COUNT,
  MAX_CHOICE_OPTIONS,
  MIN_CHOICE_OPTIONS,
} from '@/engine/grading/choice';
import type { CardTemplate, FieldDef } from '@/engine/types';

export function TemplateEditor({
  template,
  fields,
  onChange,
  onRemove,
}: {
  template: CardTemplate;
  fields: FieldDef[];
  onChange: (patch: Partial<CardTemplate>) => void;
  onRemove: () => void;
}) {
  const toggleId = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  const clozeFields = fields.filter((f) => f.kind === 'clozeSentences');
  const answerName = fields.find((f) => f.id === template.answerFieldId)?.name;
  return (
    <div className="rounded-lg border border-slate-800 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <TextInput
          aria-label="Card template name"
          value={template.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="max-w-44"
        />
        <Select
          aria-label={`Answer mode for ${template.name}`}
          value={template.grading.mode}
          onChange={(e) => {
            const mode = e.target.value;
            onChange({
              grading:
                mode === 'sentenceCloze'
                  ? {
                      mode: 'sentenceCloze',
                      sentencesFieldId: clozeFields[0]?.id ?? '',
                      rotation: 'random',
                    }
                  : mode === 'choice'
                    ? { mode: 'choice', choices: DEFAULT_CHOICE_COUNT }
                    : { mode: 'typed', answerLang: 'latin', typoTolerance: true },
            });
          }}
          title="How this card is answered"
        >
          <option value="typed">typed answer</option>
          <option value="choice">multiple choice</option>
          <option value="sentenceCloze">sentence cloze</option>
        </Select>
        {template.grading.mode === 'choice' && (
          <>
            <TextInput
              type="number"
              aria-label={`Number of choices for ${template.name}`}
              min={MIN_CHOICE_OPTIONS}
              max={MAX_CHOICE_OPTIONS}
              value={template.grading.choices}
              onChange={(e) =>
                onChange({
                  grading: { mode: 'choice', choices: clampChoiceCount(+e.target.value) },
                })
              }
              className="max-w-20"
              title="How many options to show (2–6)"
            />
            <span className="text-[11px] text-slate-500">
              options — wrong ones come from other {answerName ? `"${answerName}"` : 'answer'}{' '}
              values of this type
            </span>
          </>
        )}
        {template.grading.mode === 'typed' && (
          <>
            <Select
              aria-label={`Answer language for ${template.name}`}
              value={template.grading.answerLang}
              onChange={(e) =>
                onChange({
                  grading: {
                    ...template.grading,
                    mode: 'typed',
                    answerLang: e.target.value as 'latin' | 'kana',
                  } as CardTemplate['grading'],
                })
              }
              title="Kana answers turn the input into a romaji→kana IME and are matched exactly"
            >
              <option value="latin">latin</option>
              <option value="kana">kana (IME)</option>
            </Select>
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={template.grading.typoTolerance}
                onChange={(e) =>
                  onChange({
                    grading: {
                      ...template.grading,
                      mode: 'typed',
                      typoTolerance: e.target.checked,
                    } as CardTemplate['grading'],
                  })
                }
              />
              typo tolerance
            </label>
          </>
        )}
        {template.grading.mode === 'sentenceCloze' && (
          <Select
            aria-label={`Sentence order for ${template.name}`}
            value={template.grading.rotation}
            onChange={(e) =>
              onChange({
                grading: {
                  ...template.grading,
                  mode: 'sentenceCloze',
                  rotation: e.target.value as 'random' | 'sequential',
                } as CardTemplate['grading'],
              })
            }
            title="Which example sentence each review shows"
          >
            <option value="random">random sentence</option>
            <option value="sequential">in order</option>
          </Select>
        )}
        <div className="grow" />
        <Button
          variant="ghost"
          aria-label={`Remove ${template.name} template`}
          onClick={onRemove}
          title="Remove this template (deletes its cards)"
        >
          ✕
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Prompt (shown)">
          <div className="space-y-1">
            {fields.map((f) => (
              <label key={f.id} className="flex items-center gap-1.5 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={template.promptFieldIds.includes(f.id)}
                  onChange={() =>
                    onChange({ promptFieldIds: toggleId(template.promptFieldIds, f.id) })
                  }
                />
                {f.name}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Answer (typed)">
          <Select
            aria-label={`Answer field for ${template.name}`}
            value={template.answerFieldId}
            onChange={(e) => onChange({ answerFieldId: e.target.value })}
            className="w-full"
          >
            <option value="">— pick a field —</option>
            {fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
          {template.grading.mode === 'sentenceCloze' && (
            <span className="mt-2 block">
              <span className="mb-1 block text-xs text-slate-400">Sentences field</span>
              <Select
                aria-label={`Sentences field for ${template.name}`}
                value={template.grading.sentencesFieldId}
                onChange={(e) =>
                  onChange({
                    grading: {
                      ...template.grading,
                      mode: 'sentenceCloze',
                      sentencesFieldId: e.target.value,
                    } as CardTemplate['grading'],
                  })
                }
                className="w-full"
              >
                <option value="">— pick a cloze field —</option>
                {clozeFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </span>
          )}
        </Field>
        <Field label="Hints (revealed on request)">
          <div className="space-y-1">
            {fields.map((f) => (
              <label key={f.id} className="flex items-center gap-1.5 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={template.hintFieldIds.includes(f.id)}
                  onChange={() => onChange({ hintFieldIds: toggleId(template.hintFieldIds, f.id) })}
                />
                {f.name}
              </label>
            ))}
          </div>
        </Field>
      </div>
    </div>
  );
}
