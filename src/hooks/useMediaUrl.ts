import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { db } from '@/db/db';

/** Resolve a media id to a displayable object URL (null while loading/missing). */
export function useMediaUrl(id: string | undefined | null): string | null {
  const [resolved, setResolved] = useState<{ id: string; url: string | null } | null>(null);
  useEffect(() => {
    setResolved(null);
    if (!id) return;
    let currentUrl: string | null = null;
    const revoke = () => {
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      currentUrl = null;
    };
    // Record observation also catches same-id restores and deletions in other tabs.
    // Each consumer owns its URL, so replacing one image cannot revoke another's.
    const subscription = liveQuery(() => db.media.get(id)).subscribe({
      next(asset) {
        revoke();
        currentUrl = asset ? URL.createObjectURL(asset.blob) : null;
        setResolved({ id, url: currentUrl });
      },
      error() {
        revoke();
        setResolved({ id, url: null });
      },
    });
    return () => {
      subscription.unsubscribe();
      revoke();
    };
  }, [id]);
  return resolved && resolved.id === id ? resolved.url : null;
}
