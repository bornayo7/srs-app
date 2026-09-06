/**
 * Hand the browser a file to save. The anchor is attached to the document
 * and the object URL outlives the click: a detached anchor, or revoking the
 * URL synchronously after click(), makes Firefox and Safari abort the
 * download before it has started.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
