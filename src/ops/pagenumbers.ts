// Page-numbers op: stamp "3" or "3 / 12" onto every page in Helvetica grey.
// Kept deliberately simple — numbers are drawn in the page's UNROTATED
// coordinate space, so on pages with a /Rotate entry the number sticks to the
// media box's physical corner (it may appear along a side edge when the page
// is viewed rotated). Acceptable for v1; documented here and in the UI copy.
//
// Load errors map onto the engine taxonomy through openPdf (encrypted →
// PdfEncryptedError, unreadable → PdfCorruptError).

import { openPdf } from '../session';

export type PageNumberPosition =
  | 'bottom-center'
  | 'bottom-left'
  | 'bottom-right'
  | 'top-center'
  | 'top-left'
  | 'top-right';

/**
 * Stamp page numbers onto a PDF and return the saved bytes.
 *
 * - `format`: `'n'` → "3", `'n-of-total'` (default) → "3 / 12".
 * - `startAt` (default 1) shifts the numbering — page i shows `startAt + i`,
 *   and the "of" total shifts with it (`startAt + pageCount − 1`).
 * - `skipFirst` (default false) leaves page 1 unstamped (cover page) but
 *   keeps its slot in the numbering: page 2 still reads "2 / 12".
 * - Encrypted inputs need `password`; note the output is saved decrypted.
 */
export async function addPageNumbers(
  bytes: Uint8Array,
  opts?: {
    format?: 'n' | 'n-of-total';
    position?: PageNumberPosition;
    startAt?: number;
    size?: number;
    margin?: number;
    skipFirst?: boolean;
    password?: string;
  },
): Promise<Uint8Array> {
  const { StandardFonts, rgb } = await import('@cantoo/pdf-lib');
  const { doc } = await openPdf(bytes, 'document.pdf', undefined, opts?.password);

  const format = opts?.format ?? 'n-of-total';
  const position = opts?.position ?? 'bottom-center';
  const startAt = opts?.startAt ?? 1;
  const size = opts?.size ?? 10;
  const margin = opts?.margin ?? 24;

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const grey = rgb(0.4, 0.4, 0.4);
  const pages = doc.getPages();
  const lastNumber = startAt + pages.length - 1;

  pages.forEach((page, i) => {
    if (opts?.skipFirst && i === 0) return;
    const n = startAt + i;
    const text = format === 'n' ? `${n}` : `${n} / ${lastNumber}`;
    const { width, height } = page.getSize();
    const textWidth = font.widthOfTextAtSize(text, size);
    const x = position.endsWith('-left')
      ? margin
      : position.endsWith('-right')
        ? width - margin - textWidth
        : (width - textWidth) / 2;
    const y = position.startsWith('top') ? height - margin - size : margin;
    page.drawText(text, { x, y, size, font, color: grey });
  });

  return doc.save();
}
