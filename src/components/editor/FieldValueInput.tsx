import { useEffect, useId, useRef, useState } from 'react';
import { Button, TextArea, TextInput } from '@/components/ui';
import { MediaAudio, MediaImage } from '@/components/MediaImage';
import { RichText, RICHTEXT_HELP } from '@/components/RichText';
import { ListInput } from './ListInput';
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
  onPending,
  text,
  onTextChange,
  id,
}: {
  field: FieldDef;
  value: FieldValue | undefined;
  onChange: (v: FieldValue) => void;
  onError?: (message: string | null) => void;
  onPending?: (pending: boolean) => void;
  text?: string;
  onTextChange?: (text: string) => void;
  id?: string;
}) {
  switch (field.kind) {
    case 'list':
      return (
        <ListInput
          id={id}
          value={Array.isArray(value) && !isClozeSentences(value) ? (value as string[]) : []}
          placeholder="one, two, three"
          onChange={onChange}
        />
      );

    case 'richtext':
      return (
        <RichTextInput id={id} value={typeof value === 'string' ? value : ''} onChange={onChange} />
      );

    case 'clozeSentences':
      return (
        <ClozeInput
          id={id}
          text={text}
          onTextChange={onTextChange}
          value={isClozeSentences(value) ? value : []}
          onChange={onChange}
          onError={onError}
        />
      );

    case 'image':
    case 'audio':
      return (
        <MediaInput
          id={id}
          kind={field.kind}
          value={typeof value === 'string' ? value : ''}
          onChange={onChange}
          onError={onError}
          onPending={onPending}
        />
      );

    default:
      return (
        <TextInput
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

function RichTextInput({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
}) {
  const [preview, setPreview] = useState(false);
  return (
    <div>
      {preview ? (
        <div className="min-h-16 rounded-lg border border-slate-700 bg-slate-950/60 p-3 text-sm text-slate-300">
          <RichText src={value} />
        </div>
      ) : (
        <TextArea id={id} rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
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
  id,
  text: controlledText,
  onTextChange,
}: {
  value: import('@/engine/types').ClozeSentence[];
  onChange: (v: FieldValue) => void;
  onError?: (message: string | null) => void;
  id?: string;
  text?: string;
  onTextChange?: (text: string) => void;
}) {
  const [localText, setLocalText] = useState(() => formatClozeLines(value));
  const text = controlledText ?? localText;
  const error = text.trim() ? parseClozeLines(text).error : null;
  const errorId = useId();
  return (
    <div>
      <TextArea
        id={id}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        rows={3}
        value={text}
        placeholder={'The cat sat ⟦on⟧ the mat. :: translation here\nHang ⟦on⟧ a second!'}
        onChange={(e) => {
          setLocalText(e.target.value);
          onTextChange?.(e.target.value);
          const parsed = parseClozeLines(e.target.value);
          onError?.(parsed.error);
          if (!parsed.error) onChange(parsed.sentences);
        }}
      />
      <span className="mt-1 block text-[11px] text-slate-500">
        One sentence per line · blank in ⟦brackets⟧ · optional " :: translation"
      </span>
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-sm text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}

function MediaInput({
  kind,
  value,
  onChange,
  onError,
  onPending,
  id,
}: {
  kind: 'image' | 'audio';
  value: string;
  onChange: (v: FieldValue) => void;
  onError?: (message: string | null) => void;
  onPending?: (pending: boolean) => void;
  id?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const errorId = useId();
  const lifetime = useRef(0);
  const pendingCallback = useRef(onPending);
  pendingCallback.current = onPending;
  useEffect(
    () => () => {
      lifetime.current++;
      pendingCallback.current?.(false);
    },
    [],
  );

  async function pick(file: File | undefined) {
    if (!file) return;
    if (busy) return;
    const expected = lifetime.current;
    setBusy(true);
    onPending?.(true);
    setUploadError('');
    onError?.(null);
    try {
      const asset =
        kind === 'image' ? await ingestImage(file, now()) : await ingestAudio(file, now());
      if (lifetime.current === expected) onChange(asset.id);
    } catch (err) {
      if (lifetime.current === expected) {
        const message = err instanceof Error ? err.message : 'The attachment could not be added.';
        setUploadError(message);
        onError?.(message);
      }
    } finally {
      if (lifetime.current === expected) {
        setBusy(false);
        onPending?.(false);
      }
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {value &&
        (kind === 'image' ? (
          <MediaImage id={value} className="h-20 w-20 object-contain" />
        ) : (
          <MediaAudio id={value} />
        ))}
      <input
        id={id}
        ref={inputRef}
        type="file"
        accept={kind === 'image' ? 'image/*' : 'audio/*'}
        className="hidden"
        aria-describedby={uploadError ? errorId : undefined}
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      <Button
        type="button"
        disabled={busy}
        aria-label={value ? `Replace ${kind}` : `Choose ${kind}`}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? 'Processing…' : value ? 'Replace' : `Choose ${kind}`}
      </Button>
      {value && (
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setUploadError('');
            onError?.(null);
            onChange('');
          }}
        >
          Remove
        </Button>
      )}
      {uploadError && (
        <div className="w-full space-y-2">
          <p id={errorId} role="alert" className="text-sm text-rose-300">
            {uploadError}
          </p>
          <p className="text-xs text-slate-400">
            Your other edits{value ? ' and current attachment are' : ' are'} still here. Choose a
            file to retry.
          </p>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setUploadError('');
              onError?.(null);
            }}
          >
            {value ? 'Keep current attachment' : 'Continue without attachment'}
          </Button>
        </div>
      )}
      {kind === 'image' && (
        <span className="text-[11px] text-slate-500">Downscaled to 1024px on import.</span>
      )}
    </div>
  );
}
