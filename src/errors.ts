// Error taxonomy for the PDF engine. Every op throws one of these instead of
// leaking library errors, so the UI can react precisely: encrypted → password
// prompt, corrupt → clear message, huge → soft warning. `friendlyPdfError()`
// is the last-resort mapper for toasts.

export class PdfEncryptedError extends Error {
  constructor(message = 'This PDF is password-protected.') {
    super(message);
    this.name = 'PdfEncryptedError';
  }
}

export class PdfCorruptError extends Error {
  constructor(message = "This file couldn't be read as a PDF — it may be corrupted.") {
    super(message);
    this.name = 'PdfCorruptError';
  }
}

/** Thrown when the user cancels a password prompt — callers treat as a quiet no-op. */
export class PdfCancelledError extends Error {
  constructor() {
    super('Cancelled.');
    this.name = 'PdfCancelledError';
  }
}

// Soft threshold — above this we warn (browser RAM), we don't block.
export const PDF_SIZE_WARN_BYTES = 100 * 1024 * 1024;

/** True if a raw library error means "this PDF is encrypted". */
export function isEncryptedError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /encrypt/i.test(msg) || /password/i.test(msg);
}

/** Map any thrown value to a user-facing message for toasts. */
export function friendlyPdfError(err: unknown): string {
  if (err instanceof PdfEncryptedError) return err.message;
  if (err instanceof PdfCorruptError) return err.message;
  if (err instanceof PdfCancelledError) return '';
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong while processing the PDF.';
}
