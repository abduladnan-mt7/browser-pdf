// Forms op: enumerate the AcroForm fields inside a PDF, fill them with
// values, and (by default) flatten — bake the answers into the page content
// and remove the interactive fields so they can't be edited afterwards.
//
// Unicode: pdf-lib regenerates each filled field's appearance stream with a
// WinAnsi standard font, which throws on any non-Latin character. We try that
// default path first; on failure we embed the right Noto subset (via the
// engine's font layer) and regenerate per field. Worst case (font fetch
// unavailable, e.g. in Node) the field's VALUE is still set — we just skip
// its appearance and set /NeedAppearances so viewers redraw it themselves.
//
// Load errors map onto the engine taxonomy through openPdf (encrypted →
// PdfEncryptedError, unreadable → PdfCorruptError).

import type { PDFDocument, PDFField, PDFFont, PDFForm } from '@cantoo/pdf-lib';
import { detectScript, embedFontFor, type PdfScript } from '../fonts';
import { openPdf } from '../session';

type PdfLib = typeof import('@cantoo/pdf-lib');

export interface FormFieldInfo {
  name: string;
  type: 'text' | 'checkbox' | 'dropdown' | 'radio' | 'other';
  /** Current value: text/choice as string (may be ''), checkbox as boolean. */
  value: string | boolean;
  /** Available choices — dropdown/radio (and option lists, reported as dropdown). */
  options?: string[];
  readOnly: boolean;
}

/**
 * List the fillable form fields in a PDF. Returns [] when the document has
 * no AcroForm fields. Multi-select option lists are reported as `dropdown`
 * (this op fills a single choice). Push buttons / signature fields come back
 * as `other` — visible but not fillable here.
 */
export async function listFormFields(
  bytes: Uint8Array,
  opts?: { password?: string },
): Promise<FormFieldInfo[]> {
  const lib = await import('@cantoo/pdf-lib');
  const { doc } = await openPdf(bytes, 'document.pdf', undefined, opts?.password);
  return doc.getForm().getFields().map((field) => describeField(lib, field));
}

/**
 * Fill form fields by name and return the saved PDF bytes.
 *
 * - `values`: strings for text/dropdown/radio, booleans for checkboxes
 *   (string `'true'`/`'false'` also works for checkboxes). Empty-string
 *   choices, unknown names, read-only fields and invalid radio/option-list
 *   choices are skipped rather than failing the whole fill. Dropdowns accept
 *   values outside their option list — @cantoo/pdf-lib turns the field into
 *   an editable combo, matching how PDF combo boxes handle custom text.
 * - `flatten` (default true): bake the values in and remove the fields.
 *   If flattening itself fails (e.g. a widget with no appearance stream),
 *   the filled-but-still-editable PDF is returned instead of throwing.
 * - Encrypted inputs need `password`; note the output is saved decrypted.
 */
export async function fillForm(
  bytes: Uint8Array,
  opts: {
    values: Record<string, string | boolean>;
    flatten?: boolean;
    password?: string;
  },
): Promise<Uint8Array> {
  const lib = await import('@cantoo/pdf-lib');
  const { doc } = await openPdf(bytes, 'document.pdf', undefined, opts.password);
  const form = doc.getForm();
  const flatten = opts.flatten !== false;

  // Set the values. Each field is independent — one bad value never sinks
  // the rest of the fill.
  const touched: PDFField[] = [];
  const byName = new Map(form.getFields().map((f) => [f.getName(), f]));
  for (const [name, value] of Object.entries(opts.values)) {
    const field = byName.get(name);
    if (!field || field.isReadOnly()) continue;
    if (setFieldValue(lib, field, value)) touched.push(field);
  }

  // Regenerate appearance streams so the values actually show. May partially
  // fail on non-Latin text when the Noto fallback font can't be fetched.
  const appearancesOk = await updateAppearances(lib, doc, form, touched);
  const needAppearances = () =>
    form.acroForm.dict.set(lib.PDFName.of('NeedAppearances'), lib.PDFBool.True);

  if (flatten) {
    try {
      form.flatten({ updateFieldAppearances: false });
    } catch {
      // A widget pdf-lib can't flatten (missing appearance stream, exotic
      // structure). Keep the fields editable with their values instead.
      if (!appearancesOk) needAppearances();
    }
  } else if (!appearancesOk) {
    needAppearances();
  }

  // Appearances were handled above (including the skip case) — never let
  // save's own appearance pass re-throw on non-WinAnsi text.
  return doc.save({ updateFieldAppearances: false });
}

// ---------------------------------------------------------------------------

function describeField(lib: PdfLib, field: PDFField): FormFieldInfo {
  const name = field.getName();
  const readOnly = field.isReadOnly();
  if (field instanceof lib.PDFTextField) {
    return { name, type: 'text', value: field.getText() ?? '', readOnly };
  }
  if (field instanceof lib.PDFCheckBox) {
    return { name, type: 'checkbox', value: field.isChecked(), readOnly };
  }
  if (field instanceof lib.PDFDropdown || field instanceof lib.PDFOptionList) {
    return { name, type: 'dropdown', value: field.getSelected()[0] ?? '', options: field.getOptions(), readOnly };
  }
  if (field instanceof lib.PDFRadioGroup) {
    return { name, type: 'radio', value: field.getSelected() ?? '', options: field.getOptions(), readOnly };
  }
  return { name, type: 'other', value: '', readOnly }; // button, signature, …
}

/** Apply one value to one field. True → the field now needs an appearance pass. */
function setFieldValue(lib: PdfLib, field: PDFField, value: string | boolean): boolean {
  try {
    if (field instanceof lib.PDFTextField) {
      field.setText(String(value));
      return true;
    }
    if (field instanceof lib.PDFCheckBox) {
      if (value === true || value === 'true') field.check();
      else field.uncheck();
      return true;
    }
    if (field instanceof lib.PDFDropdown || field instanceof lib.PDFOptionList || field instanceof lib.PDFRadioGroup) {
      const choice = String(value);
      if (!choice) return false; // '' = leave unselected
      // Radio/option-list throw on a choice outside their options → skipped
      // via the catch below. Dropdowns accept custom text (editable combo).
      field.select(choice);
      return true;
    }
    return false; // buttons, signatures — nothing to set
  } catch {
    return false;
  }
}

/** Current text content of a text-like field, for script detection. */
function textOf(lib: PdfLib, field: PDFField): string {
  if (field instanceof lib.PDFTextField) return field.getText() ?? '';
  if (field instanceof lib.PDFDropdown || field instanceof lib.PDFOptionList) {
    return field.getSelected().join(' ');
  }
  return '';
}

/**
 * Regenerate appearances for the touched fields. Fast path: pdf-lib's own
 * form-wide pass (WinAnsi Helvetica). If that throws — some value has
 * non-Latin characters — fall back to per-field: WinAnsi first, then the
 * script's Noto font, then give up on that field's appearance (value stays).
 * Returns false when at least one field's appearance couldn't be drawn.
 */
async function updateAppearances(
  lib: PdfLib,
  doc: PDFDocument,
  form: PDFForm,
  touched: PDFField[],
): Promise<boolean> {
  try {
    form.updateFieldAppearances();
    return true;
  } catch {
    // Fall through to the per-field pass. Note the form-wide pass stops at
    // the first failing field, so every touched field is revisited below.
  }

  let allOk = true;
  let helvetica: PDFFont | null = null;
  const notoCache = new Map<PdfScript, PDFFont | null>();
  const notoFor = async (script: PdfScript): Promise<PDFFont | null> => {
    if (!notoCache.has(script)) {
      try {
        notoCache.set(script, await embedFontFor(doc, script));
      } catch {
        notoCache.set(script, null); // font fetch unavailable (offline / Node)
      }
    }
    return notoCache.get(script) ?? null;
  };

  for (const field of touched) {
    try {
      if (field instanceof lib.PDFCheckBox || field instanceof lib.PDFRadioGroup) {
        field.defaultUpdateAppearances(); // pure graphics — no font involved
        continue;
      }
      if (
        !(field instanceof lib.PDFTextField)
        && !(field instanceof lib.PDFDropdown)
        && !(field instanceof lib.PDFOptionList)
      ) continue;

      try {
        helvetica ??= await doc.embedFont(lib.StandardFonts.Helvetica);
        field.defaultUpdateAppearances(helvetica);
      } catch {
        const font = await notoFor(detectScript(textOf(lib, field)));
        if (!font) { allOk = false; continue; }
        field.defaultUpdateAppearances(font);
      }
    } catch {
      allOk = false; // appearance skipped; the value itself is already set
    }
  }
  return allOk;
}
