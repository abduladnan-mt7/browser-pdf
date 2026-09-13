// Password ops: add a password to a PDF (AES-encrypt) or strip a known
// password off. Extracted from the standalone PdfPasswordTool so the same
// logic powers the single-file tool AND batch mode.
//
// Both go through the engine's openPdf, so load failures map onto the taxonomy
// (encrypted / wrong password → PdfEncryptedError, unreadable → PdfCorruptError)
// instead of leaking raw library errors. @cantoo/pdf-lib is the writer (a
// pdf-lib fork with AES); openPdf lazy-imports it, so tool pages don't pay for
// the library until an op actually runs.

import { openPdf } from '../session';

/**
 * Encrypt a PDF with a password and return the saved bytes.
 *
 * - `userPassword`: required to OPEN the output.
 * - `ownerPassword` (defaults to `userPassword`): the permissions owner.
 * - `currentPassword`: pass when the SOURCE is already encrypted, so it can be
 *   opened before being re-encrypted. Wrong/missing → PdfEncryptedError.
 *
 * Permissions are left empty — an open-only lock, matching the standalone tool.
 */
export async function protectPdf(
  bytes: Uint8Array,
  opts: { userPassword: string; ownerPassword?: string; currentPassword?: string },
): Promise<Uint8Array> {
  const { doc } = await openPdf(bytes, 'document.pdf', undefined, opts.currentPassword);
  doc.encrypt({
    userPassword: opts.userPassword,
    ownerPassword: opts.ownerPassword ?? opts.userPassword,
    permissions: {},
  });
  return doc.save();
}

/**
 * Remove a known password from a PDF and return an unlocked copy — the output
 * is saved WITHOUT encryption. Wrong/missing password → PdfEncryptedError,
 * anything else unreadable → PdfCorruptError (both mapped by openPdf).
 */
export async function unlockPdf(bytes: Uint8Array, opts: { password: string }): Promise<Uint8Array> {
  const { doc } = await openPdf(bytes, 'document.pdf', undefined, opts.password);
  return doc.save();
}
