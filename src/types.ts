// Shared types for the PDF engine (src/lib/pdf). The session model is the
// spine every op and UI surface works against: source files in, a unified
// editable page list, bytes out. Pure data — no DOM, no React — so the same
// code runs in the browser and in the Node eval harness.

export interface PdfSource {
  id: string;
  name: string;
  kind: 'pdf' | 'image';
  /** Raw file bytes. For images the UI converts exotic formats (webp/heic/…) to PNG or JPEG bytes at intake. */
  bytes: Uint8Array;
  mime: string;
  /** Pages in the source document; 1 for images. */
  pageCount: number;
  /** Remembered after a successful decrypt so later exports can re-open the file. */
  password?: string;
}

export interface PdfPageRef {
  /** Stable id for UI keys/drag-reorder. */
  id: string;
  /** null → blank inserted page. */
  sourceId: string | null;
  /** 0-based page index within the source (0 for images/blank). */
  sourceIndex: number;
  /** Rotation delta applied on top of the page's own rotation. */
  rotation: 0 | 90 | 180 | 270;
  /** Page size in PDF points, blank pages only. */
  blankSize?: { width: number; height: number };
}

export interface PdfSession {
  sources: Map<string, PdfSource>;
  pages: PdfPageRef[];
}

/**
 * UI hook for encrypted files: shown the file name + attempt number, returns
 * the password or null when the user cancels.
 */
export type AskPassword = (fileName: string, attempt: number) => Promise<string | null>;
