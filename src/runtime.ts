// How the engine gets hold of pdf.js and Tesseract, without knowing anything
// about how your app loads them.
//
// These two are the only reason this code was ever tied to one website. The
// engine itself is framework-agnostic — it reads and writes PDF bytes — but
// rendering a page needs pdf.js and OCR needs Tesseract, and both are large,
// lazily-loaded, and fetched differently in every setup: a bundler import, a
// <script> tag, a CDN, a copy in /public, a different path again under a
// framework that rewrites asset URLs.
//
// Hard-coding any one of those would make the library work in exactly one
// project. So the host supplies a loader and the engine calls it when, and
// only when, a feature that needs it is actually used. Nothing is fetched
// because you imported this package.
//
// Everything else — merge, split, rotate, compress, page numbers, passwords,
// forms, typesetting, table detection, text reconstruction — has no such
// dependency and works with no configuration at all.

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The pdf.js module object, as `import('pdfjs-dist')` resolves it. */
export type PdfJsModule = any;

/**
 * The only part of Tesseract this engine touches. Deliberately structural
 * rather than an import of tesseract.js types: a host wiring up a different
 * OCR backend entirely only has to satisfy these two methods.
 */
export interface OcrWorker {
  recognize: (image: unknown) => Promise<{ data: { text: string } }>;
  terminate: () => Promise<unknown>;
}

/**
 * Produces a ready OCR worker for one language.
 *
 * A factory rather than the Tesseract module itself, because standing a worker
 * up needs to know where the engine binary and the language data are served
 * from — and only the host knows that. Baking in a path (or worse, reading
 * window.location) is what tied the original to one website.
 */
export type OcrWorkerFactory = (
  lang: string,
  onProgress?: (fraction: number) => void,
) => Promise<OcrWorker>;

type Loader<T> = () => Promise<T>;

let pdfjsLoader: Loader<PdfJsModule> | null = null;
let ocrWorkerFactory: OcrWorkerFactory | null = null;

/**
 * Tell the engine how to obtain pdf.js. Call once at startup.
 *
 * The loader is invoked lazily and its result is NOT cached here — cache it
 * yourself if the loader is expensive, which it usually is:
 *
 *   let cached: Promise<any> | null = null;
 *   setPdfJsLoader(() => (cached ??= import('pdfjs-dist').then((m) => {
 *     m.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
 *     return m;
 *   })));
 *
 * Setting the worker source is the host's job too: only the host knows where
 * the worker file is served from, and pdf.js is markedly slower without it.
 */
export function setPdfJsLoader(loader: Loader<PdfJsModule>): void {
  pdfjsLoader = loader;
}

/**
 * Tell the engine how to stand up an OCR worker. Only needed for OCR.
 *
 *   setOcrWorkerFactory(async (lang, onProgress) => {
 *     const Tesseract = await import('tesseract.js');
 *     return Tesseract.createWorker(lang, 1, {
 *       workerPath: '/tess/worker.min.js',
 *       langPath: '/tess',
 *       logger: (m) => m.status === 'recognizing text' && onProgress?.(m.progress),
 *     });
 *   });
 */
export function setOcrWorkerFactory(factory: OcrWorkerFactory): void {
  ocrWorkerFactory = factory;
}

/**
 * The error thrown when a feature needs a loader that was never set. Named and
 * exported so a host can catch it and show something better than a stack trace
 * — this is a wiring mistake, not a problem with the user's file.
 */
export class PdfEngineNotConfiguredError extends Error {
  constructor(what: 'pdf.js' | 'Tesseract', setter: string) {
    super(
      `browser-pdf needs ${what} for this operation, and no loader was set. ` +
        `Call ${setter}(() => import(...)) once during startup. Operations that ` +
        `do not need ${what} (merge, split, rotate, compress, typeset, …) work ` +
        `without it.`,
    );
    this.name = 'PdfEngineNotConfiguredError';
  }
}

export function getPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsLoader) {
    return Promise.reject(new PdfEngineNotConfiguredError('pdf.js', 'setPdfJsLoader'));
  }
  return pdfjsLoader();
}

export function createOcrWorker(
  lang: string,
  onProgress?: (fraction: number) => void,
): Promise<OcrWorker> {
  if (!ocrWorkerFactory) {
    return Promise.reject(new PdfEngineNotConfiguredError('Tesseract', 'setOcrWorkerFactory'));
  }
  return ocrWorkerFactory(lang, onProgress);
}

/** Whether OCR / page rendering are currently usable. Lets a UI hide a feature
 *  rather than offer it and then fail. */
export const isPdfJsConfigured = (): boolean => pdfjsLoader !== null;
export const isOcrConfigured = (): boolean => ocrWorkerFactory !== null;

// ——— download notifications ———————————————————————————————————————————————
//
// Every operation that hands a file to the user goes through downloadBytes, so
// this is the one place a host can hook "something actually succeeded" without
// instrumenting each tool separately. The package reports nothing on its own —
// no analytics, no beacon, no default listener.

let downloadListener: ((filename: string) => void) | null = null;

/** Called after each successful download. Pass null to remove. */
export function setDownloadListener(fn: ((filename: string) => void) | null): void {
  downloadListener = fn;
}

export function notifyDownload(filename: string): void {
  // A listener throwing must never turn a successful download into an error
  // the user sees — the file already reached them by this point.
  try { downloadListener?.(filename); } catch { /* host's problem, not ours */ }
}
