import { useMediaUrl } from '@/hooks/useMediaUrl';

/** Renders a stored image by media id, with a graceful gap when it's missing. */
export function MediaImage({
  id,
  alt = '',
  className = '',
}: {
  id: string | undefined | null;
  alt?: string;
  className?: string;
}) {
  const url = useMediaUrl(id);
  if (!id) return null;
  if (!url) {
    return (
      <div
        className={`flex items-center justify-center rounded-lg border border-dashed border-slate-700 text-xs text-slate-600 ${className}`}
      >
        image missing
      </div>
    );
  }
  return <img src={url} alt={alt} className={`max-h-full max-w-full rounded-lg ${className}`} />;
}

/** Audio playback for an audio field — user-initiated only, never autoplay. */
export function MediaAudio({ id }: { id: string | undefined | null }) {
  const url = useMediaUrl(id);
  if (!id || !url) return null;
  return <audio src={url} controls className="h-8 w-full max-w-xs" />;
}
