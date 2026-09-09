import type { FieldKind, FieldValue } from '@/engine/types';
import { isClozeSentences, revealBlank } from '@/engine/grading/cloze';
import { RichText } from '@/components/RichText';
import { MediaAudio, MediaImage } from '@/components/MediaImage';

export function QuestionField({
  kind,
  value,
  name,
}: {
  kind: FieldKind;
  value: FieldValue | undefined;
  name: string;
}) {
  if (value === undefined) return null;
  if (kind === 'image')
    return (
      <MediaImage id={typeof value === 'string' ? value : null} alt={name} className="max-h-56" />
    );
  if (kind === 'audio') return <MediaAudio id={typeof value === 'string' ? value : null} />;
  if (isClozeSentences(value))
    return (
      <ul className="space-y-2">
        {value.map((s, i) => (
          <li key={i}>
            <div>{revealBlank(s.text)}</div>
            {s.translation && <p className="text-sm text-slate-400">{s.translation}</p>}
            {s.hint && <p className="text-sm text-slate-400">Hint: {s.hint}</p>}
          </li>
        ))}
      </ul>
    );
  const text = typeof value === 'string' ? value : value.join(', ');
  return kind === 'richtext' ? <RichText src={text} /> : <>{text}</>;
}
