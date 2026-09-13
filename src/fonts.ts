// Font layer for the PDF engine — fixes the "WinAnsi Helvetica throws on any
// non-Latin character" crash. Annotation text is script-detected
// (Latin/Devanagari/Arabic), the matching self-hosted Noto TTF is fetched from
// /public/fonts/pdf/ on demand (memoized per script), fontkit is lazily
// registered on the document, and the font is embedded with `subset: true` so
// only the glyphs actually used ship in the output PDF. Pure TS, client-side;
// everything heavy (fontkit, font bytes) loads on demand.

import type { PDFDocument, PDFFont } from '@cantoo/pdf-lib';

export type PdfScript = 'latin' | 'devanagari' | 'arabic';

// `Fontkit` isn't re-exported from the @cantoo/pdf-lib root, so derive it.
type Fontkit = Parameters<PDFDocument['registerFontkit']>[0];

const FONT_FILES: Record<PdfScript, string> = {
  latin: 'NotoSans-Regular.ttf', // also covers Cyrillic + Greek
  devanagari: 'NotoSansDevanagari-Regular.ttf',
  arabic: 'NotoSansArabic-Regular.ttf',
};

/**
 * Pick the font script for a piece of text via Unicode ranges
 * (Devanagari U+0900–097F, Arabic U+0600–06FF and U+0750–077F).
 * Mixed-script text gets the first non-Latin script found.
 */
export function detectScript(text: string): PdfScript {
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp >= 0x0900 && cp <= 0x097f) return 'devanagari';
    if ((cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f)) return 'arabic';
  }
  return 'latin';
}

/** Unique scripts across all annotation texts — one font fetch per script. */
export function neededFonts(texts: string[]): PdfScript[] {
  const scripts = new Set<PdfScript>();
  for (const text of texts) scripts.add(detectScript(text));
  return [...scripts];
}

// Memoized as promises so concurrent callers share one in-flight fetch.
const fontBytesCache = new Map<PdfScript, Promise<Uint8Array>>();

/** Fetch the TTF bytes for a script; cached for the life of the module. */
export function fetchFontBytes(script: PdfScript): Promise<Uint8Array> {
  const cached = fontBytesCache.get(script);
  if (cached) return cached;
  const promise = fetch(`/fonts/pdf/${FONT_FILES[script]}`)
    .then((res) => {
      if (!res.ok) throw new Error(`Couldn't load font ${FONT_FILES[script]} (HTTP ${res.status}).`);
      return res.arrayBuffer();
    })
    .then((buf) => new Uint8Array(buf));
  fontBytesCache.set(script, promise);
  // Don't memoize failures — a flaky network shouldn't poison the session.
  promise.catch(() => fontBytesCache.delete(script));
  return promise;
}

// Documents that already have fontkit registered — makes re-registering a no-op.
const fontkitRegistered = new WeakSet<PDFDocument>();

/** Lazily load @pdf-lib/fontkit and register it on the document. Idempotent. */
export async function registerFontkit(doc: PDFDocument): Promise<void> {
  if (fontkitRegistered.has(doc)) return;
  // fontkit's Devanagari/Arabic shapers were compiled through Babel's
  // regenerator and reference a global `regeneratorRuntime` — without it,
  // drawText with non-Latin text throws. Install it before fontkit loads.
  const g = globalThis as typeof globalThis & { regeneratorRuntime?: unknown };
  if (!g.regeneratorRuntime) {
    // @ts-expect-error — ships no types; imported for its global side effect.
    const regenerator = await import('regenerator-runtime');
    g.regeneratorRuntime = g.regeneratorRuntime ?? regenerator.default ?? regenerator;
  }
  // UMD build under Node puts the API on `default`; ES build is the namespace itself.
  const fontkit = (await import('@pdf-lib/fontkit')) as unknown as { default?: Fontkit } & Fontkit;
  doc.registerFontkit(fontkit.default ?? fontkit);
  fontkitRegistered.add(doc);
}

/**
 * Everything a caller needs in one step: register fontkit, fetch the Noto TTF
 * for the script, embed it subsetted (only used glyphs end up in the PDF).
 */
export async function embedFontFor(doc: PDFDocument, script: PdfScript): Promise<PDFFont> {
  const [, bytes] = await Promise.all([registerFontkit(doc), fetchFontBytes(script)]);
  return doc.embedFont(bytes, { subset: true });
}
