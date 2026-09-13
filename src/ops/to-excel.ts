// PDF → Excel (.xlsx) for the PDF engine. Browser-only — pdfjs (via the
// shared render cache) reads each page's text layer, the PURE detector in
// ../tables finds grid-aligned tables, and SheetJS (lazy) writes the workbook.
//
// Text-item mapping follows the statement analyzer / text extractor
// precedent: pdfjs getTextContent items carry transform [a, b, c, d, e, f]
// where e/f are the item's origin in PDF points → {x, y}, plus width/height.
//
// Sheets: one worksheet per detected table, named "Page N Table M"; a page
// with text but no grid falls back to one-cell-per-line rows in a
// "Page N text" sheet so the tool still outputs something useful. Pages with
// no text at all are skipped — and when EVERY page is like that, the PDF is a
// scan, so we throw a clear "run OCR first" error instead of an empty file.

import { PdfCorruptError, PdfEncryptedError, isEncryptedError } from '../errors';
import { getPdfjsDoc } from '../render';
import { detectTables, linesToRows, type TextItem } from '../tables';
import type { PdfSource } from '../types';

export interface PdfToExcelResult {
  bytes: Uint8Array;
  tablesFound: number;
  /** At least one page had text but no detectable grid → text-lines sheet(s). */
  usedFallback: boolean;
}

// getTextContent items as pdfjs actually delivers them (loose loader types);
// marked-content items have no `str` and are skipped.
interface RawTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}

/** Plain numerics become numbers so Excel can sum them; the rest stays text. */
const toCell = (s: string): string | number => (/^-?\d+(\.\d+)?$/.test(s.trim()) ? Number(s) : s);

export async function pdfToExcel(
  source: PdfSource,
  opts?: { onProgress?: (page: number, pages: number) => void },
): Promise<PdfToExcelResult> {
  let doc: Awaited<ReturnType<typeof getPdfjsDoc>>;
  try {
    doc = await getPdfjsDoc(source);
  } catch (err) {
    if (isEncryptedError(err)) throw new PdfEncryptedError();
    throw new PdfCorruptError();
  }

  const pages = doc.numPages;
  const sheets: { name: string; rows: string[][] }[] = [];
  let tablesFound = 0;
  let usedFallback = false;

  for (let i = 1; i <= pages; i++) {
    opts?.onProgress?.(i, pages);
    const page = (await doc.getPage(i)) as unknown as {
      getTextContent(): Promise<{ items: RawTextItem[] }>;
    };
    const content = await page.getTextContent();

    const items: TextItem[] = [];
    for (const raw of content.items) {
      if (typeof raw.str !== 'string' || raw.str.trim() === '') continue;
      const t = raw.transform ?? [];
      items.push({ str: raw.str, x: t[4] ?? 0, y: t[5] ?? 0, w: raw.width ?? 0, h: raw.height ?? 0 });
    }
    if (items.length === 0) continue; // no selectable text on this page — skip

    const tables = detectTables(items);
    if (tables.length > 0) {
      tables.forEach((table, t) => {
        sheets.push({ name: `Page ${i} Table ${t + 1}`, rows: table.rows });
      });
      tablesFound += tables.length;
    } else {
      const rows = linesToRows(items);
      if (rows.length > 0) {
        sheets.push({ name: `Page ${i} text`, rows });
        usedFallback = true;
      }
    }
  }

  if (sheets.length === 0) {
    throw new Error('No selectable text — this looks like a scanned PDF. Run OCR first.');
  }

  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows.map((row) => row.map(toCell)));
    XLSX.utils.book_append_sheet(wb, ws, sheet.name);
  }
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

  return { bytes: new Uint8Array(out), tablesFound, usedFallback };
}
