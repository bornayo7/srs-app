import { useRef, useState } from 'react';
import { Button, TextArea, TextInput } from '@/components/ui';
import { MediaAudio, MediaImage } from '@/components/MediaImage';
import { RichText, RICHTEXT_HELP } from '@/components/RichText';
import { formatClozeLines, isClozeSentences, parseClozeLines } from '@/engine/grading/cloze';
import type { FieldDef, FieldValue } from '@/engine/types';
import { ingestAudio, ingestImage } from '@/services/media';
import { now } from '@/services/clock';

/** One editor control per field kind — shared by "Add item" and the item editor. */
export function FieldValueInput({
  field,
  value,
  onChange,
  onError,
}: {
  field: FieldDef;
  value: FieldValue | undefined;
  onChange: (v: FieldValue) => void;
  onError?: (message: string | null) => void;
}) {
  switch (field.kind) {
    case 'list':
      return (
        <TextInput
          value={Array.isArray(value) && !isClozeSentences(value) ? (value as string[]).join(', ') : ''}
          placeholder="one, two, three"
          onChange={(e) =>
            onChange(
              e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
        />
      );

    case 'richtext':
      return <RichTextInput value={typeof value === 'string' ? value : ''} onChange={onChange} />;

    case 'clozeSentences':
      return (
        <ClozeInput
          value={isClozeSentences(value) ? value : []}
          onChange={onChange}
          onError={onError}
        />
      );

    case 'image':
    case 'audio':
      return (
        <MediaInput
          kind={field.kind}
          value={typeof value === 'string' ? value : ''}
          onChange={onChange}
          onError={onError}
        />
      );

    default:
      return (
        <TextInput
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

function RichTextInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [preview, setPreview] = useState(false);
  return (
    <div>
      {preview ? (
        <div className="min-h-16 rounded-lg border border-slate-700 bg-slate-950/60 p-3 text-sm text-slate-300">
          <RichText src={value} />
        </div>
      ) : (
        <TextArea rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      <div className="mt-1 flex items-center justify-between">
        <span className="text-[11px] text-slate-500">{RICHTEXT_HELP}</span>
        <button
          type="button"
          className="text-[11px] text-slate-400 underline decoration-dotted hover:text-slate-200"
          onClick={() => setPreview(!preview)}
        >
          {preview ? 'edit' : 'preview'}
        </button>
      </div>
    </div>
  );
}

function ClozeInput({
  value,
  onChange,
  onError,
}: {
  value: import('@/engine/types').ClozeSentence[];
  onChange: (v: FieldValue) => void;
  onError?: (message: string | null) => void;
}) {
  const [text, setText] = useState(() => formatClozeLines(value));
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <TextArea
        rows={3}
        value={text}
        placeholder={'The cat sat ⟦on⟧ the mat. :: translation here\nHang ⟦on⟧ a second!'}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parseClozeLines(e.target.value);
          setError(parsed.error);
          onError?.(parsed.error);
          if (!parsed.error) onChange(parsed.sentences);
        }}
      />
      <span className="mt-1 block text-[11px] text-slate-500">
        One sentence per line · blank in ⟦brackets⟧ · optional " :: translation"
      </span>
      {error && <p className="mt-1 text-xs text-rose-300">{error}</p>}
    </div>
  );
}

function MediaInput({
  kind,
  value,
  onChange,
  onError,
}: {
  kind: 'image' | 'audio';
  value: string;
  onChange: (v: FieldValue) => void;
  onError?: (message: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    onError?.(null);
    try {
      const asset = kind === 'image' ? await ingestImage(file, now()) : await ingestAudio(file, now());
      onChange(asset.id);
    } catch (err) {
      onError?.((err as Error).message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className="flex items-center gap-3">
      {value &&
        (kind === 'image' ? (
          <MediaImage id={value} className="h-20 w-20 object-contain" />
        ) : (
          <MediaAudio id={value} />
        ))}
      <input
        ref={inputRef}
        type="file"
        accept={kind === 'image' ? 'image/*' : 'audio/*'}
        className="hidden"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      <Button type="button" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? 'Processing…' : value ? 'Replace' : `Choose ${kind}`}
      </Button>
      {value && (
        <Button type="button" variant="ghost" onClick={() => onChange('')}>
          Remove
        </Button>
      )}
      {kind === 'image' && (
        <span className="text-[11px] text-slate-500">Downscaled to 1024px on import.</span>
      )}
    </div>
  );
}
