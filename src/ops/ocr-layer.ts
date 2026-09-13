// OCR → searchable PDF for the PDF engine. Browser-only. Renders each page
// through render.ts, optionally runs scan cleanup, OCRs it with the shared
// tesseract loader (one worker reused across pages), then rebuilds the
// document with @cantoo/pdf-lib: the page raster as a full-page JPEG with an
// INVISIBLE text layer (opacity 0) positioned word-by-word from tesseract's
// bounding boxes — so the output looks identical but becomes selectable,
// copyable and searchable.
//
// Coordinate mapping: pages are emitted at the ORIGINAL page's size in PDF
// points — read via pdfjs `getViewport({ scale: 1 })` for PDF sources (this
// bakes in the page's own /Rotate, matching the render canvas orientation);
// image sources use the CSS-pixel convention (1px = 0.75pt, i.e. 96dpi).
// Word bboxes are in render-canvas pixels, so px→pt is a per-axis scale
// (pagePt / canvasPx) and y is flipped (PDF origin is bottom-left).

import { createOcrWorker } from '../runtime';
import type { PDFFont } from '@cantoo/pdf-lib';
import { detectScript, embedFontFor, type PdfScript } from '../fonts';
import { getPdfjsDoc, renderPage } from '../render';
import { cleanupCanvas } from './scan-cleanup';
import type { PdfSource } from '../types';

/** PDF pages render at this width (longest side, px) for OCR. */
const PDF_RENDER_WIDTH = 2200;
/** Images OCR at natural size, capped to this (longest side, px). */
const IMAGE_RENDER_CAP = 2600;
/** Points per render-canvas pixel for image sources (CSS 96dpi convention). */
const IMAGE_PX_TO_PT = 72 / 96;

export interface OcrPdfProgress {
  page: number;
  pages: number;
  status: 'render' | 'cleanup' | 'ocr' | 'build';
  pct: number; // overall 0–100 across the whole job
}

// [start, span] fractions of one page's work — OCR dominates wall time.
const STAGE_WINDOW: Record<OcrPdfProgress['status'], [number, number]> = {
  render: [0, 0.1],
  cleanup: [0.1, 0.05],
  ocr: [0.15, 0.8],
  build: [0.95, 0.05],
};

// tesseract.js v5+ only returns word boxes when `blocks` output is requested,
// and the loader's minimal worker type doesn't expose the extra recognize
// args — model just what we consume here.
interface TessBbox { x0: number; y0: number; x1: number; y1: number }
interface TessWord { text: string; bbox: TessBbox }
interface TessLine { words: TessWord[] | null }
interface TessParagraph { lines: TessLine[] | null }
interface TessBlock { paragraphs: TessParagraph[] | null }
interface TessPage { text: string; blocks: TessBlock[] | null }
interface BoxWorker {
  recognize(
    image: unknown,
    options?: Record<string, unknown>,
    output?: Record<string, boolean>,
  ): Promise<{ data: TessPage }>;
  terminate(): Promise<unknown>;
}

/**
 * Build a searchable PDF from a PDF or image source. Returns the PDF bytes
 * plus the recognized plain text (page-separated). Words whose text can't be
 * encoded in any available font are skipped (counted, logged) rather than
 * failing the build. `cancelled` is polled at stage boundaries; cancelling
 * throws `Error('Cancelled')`.
 */
export async function buildSearchablePdf(opts: {
  source: PdfSource;
  lang: string;
  cleanup?: boolean;
  onProgress?: (p: OcrPdfProgress) => void;
  cancelled?: () => boolean;
}): Promise<{ bytes: Uint8Array; text: string }> {
  const { source, lang, cleanup, onProgress, cancelled } = opts;
  const pages = Math.max(1, source.pageCount);

  const checkCancelled = () => {
    if (cancelled?.()) throw new Error('Cancelled');
  };

  // Mutable so the tesseract logger closure (created once, before the loop)
  // always reports against the page currently being recognized.
  const current = { page: 0 };
  const report = (status: OcrPdfProgress['status'], frac: number) => {
    const [start, span] = STAGE_WINDOW[status];
    const done = (current.page + start + span * Math.min(1, Math.max(0, frac))) / pages;
    onProgress?.({ page: current.page + 1, pages, status, pct: Math.min(100, Math.round(done * 100)) });
  };

  const { PDFDocument, StandardFonts } = await import('@cantoo/pdf-lib');
  const out = await PDFDocument.create();
  const helvetica = await out.embedFont(StandardFonts.Helvetica);

  // Noto fallbacks embedded at most once per script, only when needed.
  const notoFonts = new Map<PdfScript, PDFFont>();
  const notoFor = async (script: PdfScript): Promise<PDFFont> => {
    let font = notoFonts.get(script);
    if (!font) {
      font = await embedFontFor(out, script);
      notoFonts.set(script, font);
    }
    return font;
  };
  const fontFor = async (text: string): Promise<PDFFont> => {
    const script = detectScript(text);
    if (script !== 'latin') return notoFor(script);
    // Helvetica is WinAnsi-only. Route anything beyond Latin-1 (Cyrillic,
    // Greek, typographic punctuation) to Noto Sans, which covers those too.
    for (const ch of text) {
      if ((ch.codePointAt(0) ?? 0) > 0xff) return notoFor('latin');
    }
    return helvetica;
  };

  const textParts: string[] = [];
  let skippedWords = 0;

  checkCancelled();
  const worker = (await createOcrWorker(lang, (p) => report('ocr', p))) as unknown as BoxWorker;
  try {
    for (let i = 0; i < pages; i++) {
      current.page = i;
      checkCancelled();
      report('render', 0);

      const rendered = source.kind === 'pdf'
        ? await renderPage(source, i, PDF_RENDER_WIDTH)
        : await renderPage(source, 0, IMAGE_RENDER_CAP);
      let canvas = await canvasFromDataUrl(rendered.url);

      checkCancelled();
      if (cleanup) {
        report('cleanup', 0);
        canvas = cleanupCanvas(canvas, { deskew: true, enhance: true });
      }

      checkCancelled();
      report('ocr', 0);
      const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });

      checkCancelled();
      report('build', 0);

      // Output page size in points (see header comment for the mapping).
      let widthPt: number;
      let heightPt: number;
      if (source.kind === 'pdf') {
        const doc = await getPdfjsDoc(source);
        const viewport = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
        widthPt = viewport.width;
        heightPt = viewport.height;
      } else {
        widthPt = canvas.width * IMAGE_PX_TO_PT;
        heightPt = canvas.height * IMAGE_PX_TO_PT;
      }
      const scaleX = widthPt / canvas.width;
      const scaleY = heightPt / canvas.height;

      const jpeg = await out.embedJpg(await canvasToJpegBytes(canvas, 0.8));
      const page = out.addPage([widthPt, heightPt]);
      page.drawImage(jpeg, { x: 0, y: 0, width: widthPt, height: heightPt });

      for (const word of wordsOf(data)) {
        const text = word.text?.trim();
        if (!text) continue;
        try {
          const font = await fontFor(text);
          // Font size from bbox height; baseline placed at the bbox bottom
          // (descenders make the true baseline sit slightly higher — close
          // enough for selection/search alignment on an invisible layer).
          const size = Math.min(60, Math.max(4, (word.bbox.y1 - word.bbox.y0) * scaleY));
          page.drawText(text, {
            x: word.bbox.x0 * scaleX,
            y: heightPt - word.bbox.y1 * scaleY,
            size,
            font,
            opacity: 0,
          });
        } catch {
          skippedWords++; // unencodable in every available font (e.g. CJK) — keep going
        }
      }

      const pageText = (data.text ?? '').trim();
      textParts.push(pages > 1 ? `──── Page ${i + 1} ────\n${pageText}` : pageText);
      report('build', 1);
    }
  } finally {
    try {
      await worker.terminate();
    } catch {
      /* already gone */
    }
  }

  if (skippedWords > 0) {
    console.warn(`buildSearchablePdf: skipped ${skippedWords} word(s) with no encodable font — they render fine but won't be searchable.`);
  }

  checkCancelled();
  return { bytes: await out.save(), text: textParts.join('\n\n') };
}

/** Decode a data URL into a same-sized canvas. */
async function canvasFromDataUrl(url: string): Promise<HTMLCanvasElement> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Could not decode the rendered page.'));
    el.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable.');
  ctx.drawImage(img, 0, 0);
  return canvas;
}

/** Encode a canvas as JPEG bytes at the given quality. */
function canvasToJpegBytes(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Could not encode the page image.'));
          return;
        }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
      },
      'image/jpeg',
      quality,
    );
  });
}

/** Flatten tesseract's block → paragraph → line nesting into words. */
function wordsOf(page: TessPage): TessWord[] {
  const words: TessWord[] = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) words.push(word);
      }
    }
  }
  return words;
}
