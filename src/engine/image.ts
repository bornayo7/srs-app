/**
 * Pure sizing math for media ingest. Images are downscaled on the way in —
 * a 12 MP phone photo would otherwise sit in IndexedDB forever and get
 * base64-inflated into every backup.
 */

export const MAX_IMAGE_DIM = 1024;

/** Fit within a square bound, preserving aspect ratio. Never upscales. */
export function fitWithin(
  width: number,
  height: number,
  max = MAX_IMAGE_DIM,
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1, height: 1 };
  }
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
