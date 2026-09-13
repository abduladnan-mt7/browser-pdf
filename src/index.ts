// browser-pdf — read, edit and write PDFs entirely in the browser.
//
// The whole point of this package is what it does NOT do: there is no server,
// no upload, and no network call that carries the user's document. Every
// operation below runs on bytes the caller already holds, using the user's own
// CPU. That makes it usable on files people are not permitted to upload
// anywhere — contracts, payroll, medical records, anything under an NDA — which
// is the case every hosted PDF API cannot serve.
//
// Extracted from the PDF suite behind 7busyboss.com, where it runs ~20 tools in
// production. The engine is covered by an eval suite of 131 assertions built
// from synthetic PDFs, so behaviour is pinned rather than hoped for.
//
// ── Configuration ───────────────────────────────────────────────────────────
// Most of the API needs none. Rendering a page needs pdf.js and OCR needs an
// OCR worker, and because every project loads those differently, the host
// supplies them once at startup:
//
//   import { setPdfJsLoader } from 'browser-pdf';
//   let p; setPdfJsLoader(() => (p ??= import('pdfjs-dist')));
//
// See ./runtime for the details and for setOcrWorkerFactory.

// —— configuration ——
export {
  setPdfJsLoader,
  setOcrWorkerFactory,
  setDownloadListener,
  isPdfJsConfigured,
  isOcrConfigured,
  PdfEngineNotConfiguredError,
  type OcrWorker,
  type OcrWorkerFactory,
  type PdfJsModule,
} from './runtime';

// —— errors ——
// Worth using rather than matching on message text: a PDF that needs a
// password and a PDF that is genuinely broken need completely different
// messages in a UI, and pdf-lib reports both as plain Errors.
export {
  PdfEncryptedError,
  PdfCorruptError,
  PdfCancelledError,
  PDF_SIZE_WARN_BYTES,
  isEncryptedError,
  friendlyPdfError,
} from './errors';

// —— document assembly ——
// A session accumulates pages from several sources, lets you reorder, rotate,
// delete and duplicate them, then writes one PDF. Merge, split, rotate, extract
// and "organise" are all this one API used differently.
export {
  A4,
  newId,
  createSession,
  openPdf,
  addSource,
  insertBlankPage,
  duplicatePage,
  rotatePages,
  removePages,
  buildPdf,
} from './session';
export type * from './types';

// —— page ranges ——
// Parses the "1-3, 7, 12-" syntax users expect, with the off-by-one and
// backwards-range handling already thought about.
export { parsePageRanges, tryParsePageRanges } from './ranges';

// —— operations ——
export { compressPdf, canvasRecoder } from './ops/compress';
export { addPageNumbers } from './ops/pagenumbers';
export { protectPdf, unlockPdf } from './ops/password';
export { listFormFields, fillForm } from './ops/forms';
export { estimateSkew, cleanupCanvas } from './ops/scan-cleanup';

// —— rendering (needs pdf.js) ——
export { getPdfjsDoc, renderPage, releaseSource } from './render';

// —— extraction ——
// pdfToWord and pdfToExcel are text reconstruction, not layout cloning: they
// recover the words and the tables, not a visual copy. Say so in your UI —
// a user expecting a pixel-perfect Word document will be disappointed, and
// that expectation is the single most common complaint about every tool in
// this category, including the paid ones.
export { pdfToWord, SCANNED_PAGE_NOTE } from './ops/to-word';
export { pdfToExcel } from './ops/to-excel';
export { buildSearchablePdf } from './ops/ocr-layer';

// —— table detection ——
// Finds grid-aligned regions among positioned text items and returns rows of
// cells, plus the vertical band each table occupies so callers can strip those
// items out of the surrounding prose.
export { detectTables, linesToRows } from './tables';
export { reconstructBlocks } from './reconstruct';

// —— document model and typesetting ——
// A small block model (headings, paragraphs, lists, quotes, code, tables,
// images) plus a typesetter that turns it into a PDF. textToBlocks recovers
// structure from plain text; markdownToBlocks and htmlToBlocks parse properly.
export { textToBlocks, markdownToBlocks, mergeRuns } from './docmodel';
export { htmlToBlocks } from './htmlBlocks';
export { typesetBlocks, DEFAULT_MARGIN } from './ops/typeset';
export type { DocBlock, InlineRun, BlockStyle } from './docmodel';

// —— fonts ——
// Latin documents use the standard 14 PDF fonts and fetch nothing. Other
// scripts need a Unicode face, which is the one place typesetting touches the
// network — supply your own bytes via fetchFontBytes if that matters.
export { detectScript, neededFonts, fetchFontBytes, registerFontkit, embedFontFor } from './fonts';

// —— zip ——
export { uniqueNames, downloadEntries, stripExt } from './zip';
export { downloadBytes, suffixedName } from './download';
