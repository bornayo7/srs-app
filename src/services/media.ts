import { db } from '@/db/db';
import { newId } from '@/engine/ids';
import { fitWithin, MAX_IMAGE_DIM } from '@/engine/image';
import { isMediaKind } from '@/engine/typeDesign';
import type { Item, ItemType, MediaAsset } from '@/engine/types';

/**
 * Media ingest and lookup. Images are decoded, downscaled and re-encoded on
 * the way in so IndexedDB never holds a 12 MP original. Field values store the
 * media id; nothing else in the app knows about blobs.
 */

/** Refuse absurd files before decoding them — decode allocates width×height×4 bytes. */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

async function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality: number,
): Promise<Blob | null> {
  if ('convertToBlob' in canvas) {
    try {
      return await canvas.convertToBlob({ type, quality });
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function makeCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const el = document.createElement('canvas');
  el.width = width;
  el.height = height;
  return el;
}

async function decode(file: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file);
  throw new Error('this browser cannot decode images for resizing');
}

/**
 * Store an image, downscaled to fit MAX_IMAGE_DIM and re-encoded as WebP.
 * Keeps the original bytes when re-encoding would not actually save anything
 * (already-small images, or formats WebP loses to).
 */
export async function ingestImage(file: File, now: number): Promise<MediaAsset> {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name} is not an image`);
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(`${file.name} is too large (limit 25 MB)`);
  }

  let blob: Blob = file;
  let mimeType = file.type;
  // SVG is already tiny and vector — rasterizing it would only lose quality
  if (file.type !== 'image/svg+xml') {
    try {
      const bitmap = await decode(file);
      const size = fitWithin(bitmap.width, bitmap.height, MAX_IMAGE_DIM);
      const canvas = makeCanvas(size.width, size.height);
      const ctx = canvas.getContext('2d') as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, size.width, size.height);
        const encoded = await canvasToBlob(canvas, 'image/webp', 0.85);
        const shrank = size.width !== bitmap.width || size.height !== bitmap.height;
        if (encoded && (shrank || encoded.size < file.size)) {
          blob = encoded;
          mimeType = 'image/webp';
        }
      }
      bitmap.close();
    } catch {
      // decoding failed (exotic format, memory) — store the original as-is
    }
  }

  const asset: MediaAsset = {
    id: newId(),
    blob,
    mimeType,
    name: file.name,
    createdAt: now,
  };
  await db.media.add(asset);
  return asset;
}

export async function ingestAudio(file: File, now: number): Promise<MediaAsset> {
  if (!file.type.startsWith('audio/')) throw new Error(`${file.name} is not an audio file`);
  if (file.size > MAX_AUDIO_BYTES) throw new Error(`${file.name} is too large (limit 10 MB)`);
  const asset: MediaAsset = {
    id: newId(),
    blob: file,
    mimeType: file.type,
    name: file.name,
    createdAt: now,
  };
  await db.media.add(asset);
  return asset;
}

// Object URLs live for the page's lifetime: media is small, and revoking one
// still displayed elsewhere would blank the image.
const urlCache = new Map<string, string>();

export async function mediaUrl(id: string): Promise<string | null> {
  if (!id) return null;
  const cached = urlCache.get(id);
  if (cached) return cached;
  const asset = await db.media.get(id);
  if (!asset) return null;
  const url = URL.createObjectURL(asset.blob);
  urlCache.set(id, url);
  return url;
}

function forgetUrl(id: string): void {
  const url = urlCache.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(id);
  }
}

/** Media ids referenced by one item, per its type's image/audio fields. */
export function collectMediaIds(item: Item, itemType: ItemType): string[] {
  return itemType.fields
    .filter((f) => isMediaKind(f.kind))
    .map((f) => item.fieldValues[f.id])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/**
 * Delete the given media unless some item still points at it — called after
 * item deletion and after an image field is replaced.
 */
export async function deleteOrphanMedia(ids: string[]): Promise<number> {
  const candidates = ids.filter(Boolean);
  if (candidates.length === 0) return 0;
  const referenced = new Set<string>();
  const items = await db.items.toArray();
  for (const item of items) {
    for (const v of Object.values(item.fieldValues)) {
      if (typeof v === 'string' && candidates.includes(v)) referenced.add(v);
    }
  }
  const orphans = candidates.filter((id) => !referenced.has(id));
  if (orphans.length > 0) {
    await db.media.bulkDelete(orphans);
    orphans.forEach(forgetUrl);
  }
  return orphans.length;
}

/**
 * Sweep every stored asset no item points at — abandoned uploads (a picked
 * image on a form the user never submitted) accumulate otherwise.
 */
export async function purgeOrphanMedia(): Promise<number> {
  const ids = await db.media.toCollection().primaryKeys();
  return deleteOrphanMedia(ids as string[]);
}

/** Total bytes held in the media table — surfaced in Settings. */
export async function mediaUsage(): Promise<{ count: number; bytes: number }> {
  const all = await db.media.toArray();
  return { count: all.length, bytes: all.reduce((sum, m) => sum + (m.blob?.size ?? 0), 0) };
}
