// PDF→Word op for the PDF engine. Browser-only: extracts positioned text
// items per page via the shared pdfjs cache (render.ts getPdfjsDoc), feeds
// them through the pure layout reconstruction (reconstruct.ts), then builds a
// .docx with the lazily-imported `docx` package — one docx section per PDF
// page (sections start on a new page, so pagination is preserved), headings
// as HEADING_1/2, bullets via the docx bullet API, grid-aligned regions as
// real Word tables (detectTables from ../tables, the same detector PDF→Excel
// uses), everything else as plain paragraphs.
//
// This is text reconstruction, not layout cloning — multi-column pages,
// headers/footers and text inside images still come out simplified, and the
// UI says so above the dropzone. But "simplified" used to mean every cell of
// every invoice arriving as a separate loose paragraph in column order, which
// is a different and much worse thing than a simplified layout. Tables were
// the single biggest gap between this converter and its own ceiling.

import { getPdfjsDoc } from '../render';
import { reconstructBlocks, type DocBlock, type TextItem } from '../reconstruct';
import { detectTables } from '../tables';
import type { PdfSource } from '../types';

/** Inserted (italic) for pages with no extractable text — scans need OCR. */
export const SCANNED_PAGE_NOTE =
  '[This page appears to be a scanned image — run OCR first for text.]';

// Minimal shapes for what we consume from pdfjs (the dynamic loader's types
// are loose; render.ts models pages the same way).
interface PdfjsTextItem {
  str: string;
  /** [scaleX, skewY, skewX, scaleY, x, y] in PDF points. */
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
}
interface PdfjsTextPage {
  getTextContent(): Promise<{ items: unknown[] }>;
  commonObjs: { get(name: string): unknown };
}

const BOLD_NAME_RE = /bold|black|heavy|semibold|demibold/i;

/**
 * Convert a PDF source to .docx bytes. Encrypted sources work when
 * `source.password` is set (the UI resolves it via openPdf first — same
 * pattern as the other ops). `onScannedPage` fires once per page that had no
 * text items (0-based index) so the UI can count scans and point at OCR.
 */
export async function pdfToWord(
  source: PdfSource,
  opts?: {
    onProgress?: (page: number, pages: number) => void;
    onScannedPage?: (pageIndex: number) => void;
  },
): Promise<Uint8Array> {
  const doc = await getPdfjsDoc(source);
  const pages = doc.numPages;

  // — extract positioned text items per page —
  const itemPages: TextItem[][] = [];
  for (let i = 0; i < pages; i++) {
    const page = (await doc.getPage(i + 1)) as unknown as PdfjsTextPage;
    const content = await page.getTextContent();

    // Resolved per page: fontName → looks bold? Checked against the loaded
    // font's real name (e.g. "ABCDE+Arial-BoldMT") via commonObjs when
    // available, falling back to the internal name itself.
    const boldCache = new Map<string, boolean>();
    const isBold = (fontName?: string): boolean => {
      if (!fontName) return false;
      let bold = boldCache.get(fontName);
      if (bold === undefined) {
        bold = BOLD_NAME_RE.test(fontName);
        if (!bold) {
          try {
            const font = page.commonObjs.get(fontName) as { name?: string } | null;
            bold = BOLD_NAME_RE.test(font?.name ?? '');
          } catch {
            bold = false; // font object not resolved — assume regular
          }
        }
        boldCache.set(fontName, bold);
      }
      return bold;
    };

    const items: TextItem[] = [];
    for (const raw of content.items) {
      const item = raw as Partial<PdfjsTextItem>;
      if (typeof item.str !== 'string' || !Array.isArray(item.transform)) continue; // marked-content entries
      // Font size = magnitude of the transform's vertical axis (handles
      // rotated text); item.height is 0 for some producers, so it's only a
      // fallback.
      const fontSize = Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0) || item.height || 12;
      items.push({
        str: item.str,
        x: item.transform[4] ?? 0,
        y: item.transform[5] ?? 0,
        w: item.width ?? 0,
        h: item.height || fontSize,
        fontSize,
        bold: isBold(item.fontName),
      });
    }
    itemPages.push(items);
    opts?.onProgress?.(i + 1, pages);
  }

  // — split each page into tables and the prose around them —
  //
  // Tables are the reason this converter used to feel useless on real
  // documents: invoices, statements and reports are mostly grids, and without
  // this every cell arrived as its own loose paragraph, in column order, with
  // the row structure gone. detectTables() already existed for PDF→Excel; it
  // simply was never called here.
  //
  // Each detected table reports the vertical band it occupies so its cells can
  // be removed from the prose stream — otherwise every cell would appear
  // twice, once in the table and once as a stray paragraph beside it.
  type PagePart =
    | { kind: 'text'; segment: number }
    | { kind: 'table'; rows: string[][] };

  const pageParts: PagePart[][] = [];
  /** Prose runs, flattened across pages, fed to reconstructBlocks as a batch. */
  const textSegments: TextItem[][] = [];

  for (const items of itemPages) {
    const parts: PagePart[] = [];
    const bands = detectTables(items).slice().sort((a, b) => b.yTop - a.yTop);
    const loose = bands.length
      ? items.filter((it) => !bands.some((b) => it.y <= b.yTop && it.y >= b.yBottom))
      : items;

    // Walk down the page emitting prose above each table, then the table.
    let ceiling = Number.POSITIVE_INFINITY;
    for (const band of bands) {
      const above = loose.filter((it) => it.y < ceiling && it.y > band.yTop);
      if (above.length) {
        parts.push({ kind: 'text', segment: textSegments.length });
        textSegments.push(above);
      }
      parts.push({ kind: 'table', rows: band.rows });
      ceiling = band.yBottom;
    }
    const below = loose.filter((it) => it.y < ceiling);
    if (below.length) {
      parts.push({ kind: 'text', segment: textSegments.length });
      textSegments.push(below);
    }
    pageParts.push(parts);
  }

  // Reconstruction runs over every prose run at once, exactly as it used to
  // run over every page at once — it infers heading levels from font sizes
  // seen across the whole document, so batching keeps that judgement intact.
  const segmentBlocks = reconstructBlocks(textSegments);

  // A page with no text items at all had no text layer: that is a scan, and
  // the caller points the user at OCR. Checked on the items rather than the
  // reconstructed blocks so that a page holding only a table never counts.
  itemPages.forEach((items, i) => {
    if (items.length === 0) opts?.onScannedPage?.(i);
  });

  // — build the .docx —
  const {
    Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
  } = await import('docx');

  const toParagraph = (block: DocBlock) => {
    switch (block.kind) {
      case 'heading1':
        return new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_1 });
      case 'heading2':
        return new Paragraph({ text: block.text, heading: HeadingLevel.HEADING_2 });
      case 'bullet':
        return new Paragraph({ text: block.text, bullet: { level: 0 } });
      default:
        return new Paragraph({ text: block.text });
    }
  };

  /**
   * One detected grid as a real Word table. The first row is treated as the
   * header and bolded: detectTables only ever returns column-aligned runs, so
   * a leading label row is the overwhelmingly common shape, and a bold row
   * that turns out to be data is a far smaller error than emitting a grid with
   * no visible structure at all.
   */
  const toTable = (rows: string[][]) =>
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: rows.map((cells, r) =>
        new TableRow({
          children: cells.map((cell) =>
            new TableCell({
              children: [
                new Paragraph({ children: [new TextRun({ text: cell, bold: r === 0 })] }),
              ],
            }),
          ),
        }),
      ),
    });

  const wordDoc = new Document({
    // One section per PDF page — docx sections default to starting on a new
    // page, which keeps the original pagination.
    sections: pageParts.map((parts) => {
      const children = parts.flatMap((part) =>
        part.kind === 'table'
          ? [toTable(part.rows), new Paragraph({ text: '' })] // spacer: adjacent tables merge in Word
          : segmentBlocks[part.segment].map(toParagraph),
      );
      return {
        properties: {},
        children: children.length > 0
          ? children
          : [new Paragraph({ children: [new TextRun({ text: SCANNED_PAGE_NOTE, italics: true })] })],
      };
    }),
  });

  // Packer.toBuffer needs Node's Buffer (jszip "nodebuffer"), which browsers
  // don't have — toArrayBuffer is the browser-safe equivalent.
  return new Uint8Array(await Packer.toArrayBuffer(wordDoc));
}
