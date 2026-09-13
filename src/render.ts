// pdfjs render cache for the PDF engine. Parses each source document at most
// once and renders each (page, scale) at most once, so thumbnail grids and
// the editor stop re-parsing the whole file per page (the old PdfEditor did
// exactly that). Browser-only — pdfjs needs canvas.

import { getPdfJs } from './runtime';
import type { PdfSource } from './types';

// pdfjs types are loose through the dynamic loader; keep a minimal shape.
interface PdfjsPage {
  getViewport(opts: { scale: number; rotation?: number }): { width: number; height: number };
  render(opts: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
    canvas?: HTMLCanvasElement;
    intent?: string;
  }): { promise: Promise<void> };
}
interface PdfjsDoc {
  numPages: number;
  getPage(n: number): Promise<PdfjsPage>;
  destroy(): Promise<void>;
}

const docs = new Map<string, Promise<PdfjsDoc>>();
const renders = new Map<string, Promise<RenderedPage>>();

export interface RenderedPage {
  url: string; // data URL (JPEG)
  width: number;
  height: number;
}

/** Parse a source with pdfjs, memoized per source id (password-aware). */
export function getPdfjsDoc(source: PdfSource): Promise<PdfjsDoc> {
  let cached = docs.get(source.id);
  if (!cached) {
    cached = (async () => {
      const pdfjs = await getPdfJs();
      // pdfjs transfers the buffer to its worker — hand it a copy so
      // source.bytes stays usable for export.
      return pdfjs.getDocument({ data: source.bytes.slice(), password: source.password }).promise as Promise<PdfjsDoc>;
    })();
    docs.set(source.id, cached);
    cached.catch(() => docs.delete(source.id)); // don't cache failures
  }
  return cached;
}

/**
 * Render one page to a JPEG data URL, memoized by (source, page, targetWidth,
 * rotation). `targetWidth` is pixels for the longest side — 300 for
 * thumbnails, 1000+ for the editor canvas. `rotation` (0/90/180/270)
 * overrides the page's own rotation when given (the editor bakes rotation
 * into the rendered image); omit it to respect the document's rotation.
 * Returned width/height are the CANVAS pixel dimensions.
 */
export function renderPage(source: PdfSource, pageIndex: number, targetWidth = 300, rotation?: number): Promise<RenderedPage> {
  const key = `${source.id}:${pageIndex}:${targetWidth}:${rotation ?? 'auto'}`;
  let cached = renders.get(key);
  if (!cached) {
    cached = (async () => {
      if (source.kind === 'image') {
        // Images render as themselves — just measure.
        const blob = new Blob([source.bytes as BlobPart], { type: source.mime });
        const url = URL.createObjectURL(blob);
        try {
          const img = await loadImage(url);
          return { url: await imageToDataUrl(img, targetWidth), width: img.naturalWidth, height: img.naturalHeight };
        } finally {
          URL.revokeObjectURL(url);
        }
      }

      const doc = await getPdfjsDoc(source);
      const page = await doc.getPage(pageIndex + 1);
      const viewportOf = (scale: number) =>
        rotation === undefined ? page.getViewport({ scale }) : page.getViewport({ scale, rotation });
      const base = viewportOf(1);
      const scale = targetWidth / Math.max(base.width, base.height);
      const viewport = viewportOf(scale);

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable.');
      // JPEG has no alpha — paint white so transparent page areas don't go black.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // 'print' intent renders without requestAnimationFrame pacing, so pages
      // keep rendering even in a hidden/background tab (display intent stalls
      // there). We produce static snapshots, so print appearance is right.
      await page.render({ canvasContext: ctx, viewport, canvas, intent: 'print' }).promise;

      return { url: canvas.toDataURL('image/jpeg', 0.82), width: canvas.width, height: canvas.height };
    })();
    renders.set(key, cached);
    cached.catch(() => renders.delete(key));
  }
  return cached;
}

/** Drop a source's parsed doc + rendered pages (call when a file is removed). */
export async function releaseSource(sourceId: string): Promise<void> {
  const doc = docs.get(sourceId);
  docs.delete(sourceId);
  for (const key of Array.from(renders.keys())) {
    if (key.startsWith(`${sourceId}:`)) renders.delete(key);
  }
  if (doc) {
    try { (await doc).destroy(); } catch { /* already gone */ }
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image.'));
    img.src = url;
  });
}

async function imageToDataUrl(img: HTMLImageElement, targetWidth: number): Promise<string> {
  const scale = Math.min(1, targetWidth / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable.');
  // JPEG has no alpha — flatten transparent images onto white, not black.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}
