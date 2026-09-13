// PDF engine session core: load sources (with password retry for encrypted
// files), manage the unified page list, and export back to PDF bytes.
// DOM-free — runs in the browser and in the Node eval harness alike.
// The PDF writer is @cantoo/pdf-lib (pdf-lib fork with AES), always loaded
// lazily so tool pages don't pay for it until first use.

import type { PDFDocument as PDFDocumentType } from '@cantoo/pdf-lib';
import { PdfCancelledError, PdfCorruptError, PdfEncryptedError, isEncryptedError } from './errors';
import type { AskPassword, PdfPageRef, PdfSession, PdfSource } from './types';

// A4 portrait in PDF points — default for blank pages when no sibling to copy.
export const A4 = { width: 595.28, height: 841.89 };

let uid = 0;
export const newId = (prefix = 'p'): string => `${prefix}${Date.now().toString(36)}-${uid++}`;

export function createSession(): PdfSession {
  return { sources: new Map(), pages: [] };
}

/**
 * Open PDF bytes, retrying with a password prompt when encrypted.
 * Returns the parsed doc plus the password that worked (if any).
 */
export async function openPdf(
  bytes: Uint8Array,
  name: string,
  askPassword?: AskPassword,
  knownPassword?: string,
): Promise<{ doc: PDFDocumentType; password?: string }> {
  const { PDFDocument } = await import('@cantoo/pdf-lib');

  const tryLoad = async (password?: string) =>
    password === undefined ? PDFDocument.load(bytes) : PDFDocument.load(bytes, { password });

  try {
    return { doc: await tryLoad(knownPassword), password: knownPassword };
  } catch (err) {
    if (!isEncryptedError(err)) throw new PdfCorruptError();
    if (!askPassword) throw new PdfEncryptedError();

    for (let attempt = 1; attempt <= 3; attempt++) {
      const password = await askPassword(name, attempt);
      if (password === null) throw new PdfCancelledError();
      try {
        return { doc: await tryLoad(password), password };
      } catch (retryErr) {
        if (!isEncryptedError(retryErr)) throw new PdfCorruptError();
      }
    }
    throw new PdfEncryptedError('Wrong password — this PDF stays locked.');
  }
}

/**
 * Add a file to the session. PDFs get one PdfPageRef per page; images get one.
 * Image bytes must already be PNG or JPEG (UI converts exotic formats first).
 */
export async function addSource(
  session: PdfSession,
  // `name` and `mime` are optional because a library caller often has nothing
  // but bytes — from a fetch, a clipboard paste, another tool's output — and
  // should not have to invent a filename and a MIME type to get started. When
  // they are absent the type is sniffed from the bytes themselves, which is
  // more reliable than either anyway: a file called .pdf is frequently not one.
  input: { name?: string; bytes: Uint8Array; mime?: string },
  askPassword?: AskPassword,
): Promise<PdfSource> {
  const sniffedPdf =
    input.bytes.length > 4 &&
    input.bytes[0] === 0x25 && input.bytes[1] === 0x50 &&
    input.bytes[2] === 0x44 && input.bytes[3] === 0x46; // "%PDF"
  const name = input.name ?? (sniffedPdf ? 'document.pdf' : 'image');
  const isPdf = input.mime
    ? input.mime === 'application/pdf'
    : sniffedPdf || /\.pdf$/i.test(name);
  let pageCount = 1;
  let password: string | undefined;

  if (isPdf) {
    const opened = await openPdf(input.bytes, name, askPassword);
    pageCount = opened.doc.getPageCount();
    password = opened.password;
  }

  const source: PdfSource = {
    id: newId('s'),
    name,
    kind: isPdf ? 'pdf' : 'image',
    bytes: input.bytes,
    mime: input.mime ?? (isPdf ? "application/pdf" : "application/octet-stream"),
    pageCount,
    password,
  };
  session.sources.set(source.id, source);

  for (let i = 0; i < pageCount; i++) {
    session.pages.push({ id: newId(), sourceId: source.id, sourceIndex: i, rotation: 0 });
  }
  return source;
}

/** Insert a blank page at `index` (defaults to the size of the page before it, else A4). */
export function insertBlankPage(session: PdfSession, index: number, size?: { width: number; height: number }): PdfPageRef {
  const page: PdfPageRef = {
    id: newId(),
    sourceId: null,
    sourceIndex: 0,
    rotation: 0,
    blankSize: size ?? A4,
  };
  session.pages.splice(Math.max(0, Math.min(index, session.pages.length)), 0, page);
  return page;
}

/** Duplicate a page right after itself. */
export function duplicatePage(session: PdfSession, pageId: string): PdfPageRef | null {
  const i = session.pages.findIndex((p) => p.id === pageId);
  if (i === -1) return null;
  const copy: PdfPageRef = { ...session.pages[i], id: newId() };
  session.pages.splice(i + 1, 0, copy);
  return copy;
}

/** Rotate the given pages by a delta (adds to any existing delta). */
export function rotatePages(session: PdfSession, pageIds: string[], delta: 90 | 180 | 270): void {
  const ids = new Set(pageIds);
  for (const p of session.pages) {
    if (ids.has(p.id)) p.rotation = (((p.rotation + delta) % 360) + 360) % 360 as PdfPageRef['rotation'];
  }
}

/** Remove pages from the list (sources stay — other refs may still use them). */
export function removePages(session: PdfSession, pageIds: string[]): void {
  const ids = new Set(pageIds);
  session.pages = session.pages.filter((p) => !ids.has(p.id));
}

/**
 * Export pages (defaults to all, in current order) into a fresh PDF.
 * Sources are parsed at most once each; page rotation deltas are baked on
 * top of each page's own rotation. Blank pages become empty pages, images
 * become full-bleed pages sized to the image.
 */
export async function buildPdf(session: PdfSession, pages?: PdfPageRef[]): Promise<Uint8Array> {
  const { PDFDocument, degrees } = await import('@cantoo/pdf-lib');
  const wanted = pages ?? session.pages;
  if (wanted.length === 0) throw new Error('Nothing to export — every page was removed.');

  const out = await PDFDocument.create();
  const parsed = new Map<string, PDFDocumentType>();

  const sourceDoc = async (source: PdfSource): Promise<PDFDocumentType> => {
    let doc = parsed.get(source.id);
    if (!doc) {
      const opened = await openPdf(source.bytes, source.name, undefined, source.password);
      doc = opened.doc;
      parsed.set(source.id, doc);
    }
    return doc;
  };

  for (const ref of wanted) {
    if (ref.sourceId === null) {
      const size = ref.blankSize ?? A4;
      const page = out.addPage([size.width, size.height]);
      if (ref.rotation) page.setRotation(degrees(ref.rotation));
      continue;
    }

    const source = session.sources.get(ref.sourceId);
    if (!source) continue; // source vanished — skip rather than crash

    if (source.kind === 'pdf') {
      const doc = await sourceDoc(source);
      const [copied] = await out.copyPages(doc, [ref.sourceIndex]);
      if (ref.rotation) {
        const existing = copied.getRotation().angle;
        copied.setRotation(degrees((((existing + ref.rotation) % 360) + 360) % 360));
      }
      out.addPage(copied);
    } else {
      const isJpg = /jpe?g$/i.test(source.mime) || /\.jpe?g$/i.test(source.name);
      const image = isJpg ? await out.embedJpg(source.bytes) : await out.embedPng(source.bytes);
      const page = out.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
      if (ref.rotation) page.setRotation(degrees(ref.rotation));
    }
  }

  return out.save();
}
