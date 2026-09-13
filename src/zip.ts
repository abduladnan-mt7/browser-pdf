// Multi-file output helper for the converter family: N results → one ZIP
// download (single results skip the ZIP and download directly). JSZip loads
// on demand so tools that convert one file never pay for it.

import { downloadBytes } from './download';

export interface ZipEntry {
  name: string;
  data: Uint8Array | Blob | string;
}

/** De-dupe entry names ("a.txt", "a (2).txt", …) — ZIPs silently overwrite. */
export function uniqueNames(entries: ZipEntry[]): ZipEntry[] {
  const seen = new Map<string, number>();
  return entries.map((e) => {
    const n = (seen.get(e.name) ?? 0) + 1;
    seen.set(e.name, n);
    if (n === 1) return e;
    const dot = e.name.lastIndexOf('.');
    const renamed = dot > 0 ? `${e.name.slice(0, dot)} (${n})${e.name.slice(dot)}` : `${e.name} (${n})`;
    return { ...e, name: renamed };
  });
}

/** One entry → plain download; many → ZIP named zipName. */
export async function downloadEntries(entries: ZipEntry[], zipName: string, singleMime?: string): Promise<void> {
  if (entries.length === 0) return;
  if (entries.length === 1) {
    const e = entries[0];
    const data = typeof e.data === 'string' ? new Blob([e.data], { type: singleMime ?? 'text/plain;charset=utf-8' }) : e.data;
    downloadBytes(e.name, data, singleMime);
    return;
  }
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  for (const e of uniqueNames(entries)) zip.file(e.name, e.data);
  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBytes(zipName, blob, 'application/zip');
}

/** "report.pdf" → "report" (for building output names). */
export function stripExt(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '');
}
