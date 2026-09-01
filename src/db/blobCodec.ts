/**
 * Blob ↔ base64 for JSON backups. Media is the only binary the app stores, and
 * backups must stay a single self-contained JSON file (P3 keeps that promise
 * by inlining the downscaled bytes rather than moving backups to a zip).
 */

const CHUNK = 0x8000; // btoa on a huge spread would blow the argument limit

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBlob(data: string, mimeType: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}
