import { useEffect, useState } from 'react';
import { mediaUrl } from '@/services/media';

/** Resolve a media id to a displayable object URL (null while loading/missing). */
export function useMediaUrl(id: string | undefined | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!id) {
      setUrl(null);
      return;
    }
    void mediaUrl(id).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [id]);
  return url;
}
