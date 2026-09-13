// Blob/bytes download helper shared by every PDF tool — replaces the
// create-anchor-click-revoke pattern previously copy-pasted per component.

import { notifyDownload } from './runtime';

/**
 * Trigger a browser download for raw bytes or a Blob.
 *
 * Also the natural "the tool actually worked" signal: a file reaching the user
 * is the moment anything succeeded. Every operation routes through here
 * (downloadEntries delegates to it too), so a host can count completions from
 * this one place rather than instrumenting each tool — register a callback
 * with setDownloadListener. Nothing is reported unless you do; the package
 * itself measures nothing.
 */
export function downloadBytes(name: string, data: Uint8Array | Blob, mime = 'application/pdf'): void {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Give the browser a beat to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  notifyDownload(name);
}

/** "report.pdf" + "-signed" → "report-signed.pdf" (keeps extension sane). */
export function suffixedName(original: string, suffix: string, ext = 'pdf'): string {
  const base = original.replace(/\.[a-z0-9]+$/i, '');
  return `${base}${suffix}.${ext}`;
}
