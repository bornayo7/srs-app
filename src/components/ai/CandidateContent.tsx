import type { FieldValue, ItemType, ProposalItem } from '@/engine/types';
import { isClozeSentences } from '@/engine/grading/cloze';
import { MediaAudio, MediaImage } from '@/components/MediaImage';
import { RichText } from '@/components/RichText';

/** The review surface displays every actual field, including structured sentences. */
export function CandidateContent({ item, type }: { item: ProposalItem; type?: ItemType }) {
  const display = (name: string, value: FieldValue) => {
    const kind = type?.fields.find(
      (f) => f.name.toLocaleLowerCase() === name.toLocaleLowerCase() || f.id === name,
    )?.kind;
    if (kind === 'image' && typeof value === 'string')
      return <MediaImage id={value} alt={name} className="max-h-48" />;
    if (kind === 'audio' && typeof value === 'string') return <MediaAudio id={value} />;
    if (isClozeSentences(value))
      return (
        <ol className="space-y-2">
          {value.map((sentence, index) => (
            <li key={index}>
              <p className="study-prompt">{sentence.text}</p>
              {sentence.translation && (
                <p className="text-sm text-slate-400">{sentence.translation}</p>
              )}
              {sentence.hint && <p className="text-xs text-slate-500">Hint: {sentence.hint}</p>}
            </li>
          ))}
        </ol>
      );
    if (Array.isArray(value)) return value.join(', ');
    return <RichText src={value} />;
  };
  const synonyms = Array.isArray(item.synonyms) ? { 'Also accept': item.synonyms } : item.synonyms;
  return (
    <div className="min-w-0 space-y-2 break-words">
      {item.type && <p className="text-xs font-medium text-violet-300">{item.type}</p>}
      <dl className="space-y-2">
        {Object.entries(item.fields).map(([name, value]) => (
          <div key={name}>
            <dt className="text-xs text-slate-500">{name}</dt>
            <dd className="text-sm text-slate-200">{display(name, value)}</dd>
          </div>
        ))}
      </dl>
      {synonyms &&
        Object.entries(synonyms).map(([name, list]) => (
          <p key={name} className="text-xs text-slate-400">
            {name}: {list.join(', ')}
          </p>
        ))}
      {item.note && (
        <div className="text-sm text-violet-300">
          <RichText src={item.note} />
        </div>
      )}
    </div>
  );
}
