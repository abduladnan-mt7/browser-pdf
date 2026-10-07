# browser-pdf

Read, edit and write PDFs entirely in the browser. No server, no upload, no
network call that carries the document.

Merge, split, rotate, reorder, compress, add page numbers, set or remove
passwords, fill forms, sign, OCR, and convert to Word or Excel — all on bytes
the page already holds, using the user's own CPU.

```bash
npm install browser-pdf
```

## Why this exists

Almost every PDF tool on the web uploads your file to a server. That is not a
security oversight, it is the architecture: browsers could not do this work when
those tools were built, so the file had to be sent somewhere that could.

Browsers can now. Which means a whole category of documents becomes workable —
contracts, payroll, medical letters, client files, anything under an NDA or a
data-handling policy. Those are exactly the files people are not allowed to
upload, and therefore exactly the files no hosted PDF API can process.

It also removes the reason hosted tools meter you. There is no per-file cost to
anyone, so there is no file-size cap, no daily quota and no account.

## Quick start

Nothing needs configuring for the majority of the API:

```ts
import { createSession, addSource, buildPdf } from 'browser-pdf';

const session = createSession();
await addSource(session, { bytes: firstPdf });
await addSource(session, { bytes: secondPdf });
const merged = await buildPdf(session);   // Uint8Array
```

A session holds pages from any number of sources and lets you reorder, rotate,
duplicate and delete them before writing. Merge, split, extract and "organise"
are all this one API used differently.

```ts
import { parsePageRanges, removePages, buildPdf } from 'browser-pdf';

const keep = parsePageRanges('1-3, 7, 12-', session.pages.length);
```

## Rendering and OCR need wiring

Two features depend on large libraries that every project loads differently, so
the host supplies them once rather than the package guessing:

```ts
import { setPdfJsLoader, setOcrWorkerFactory } from 'browser-pdf';

let pdfjs;
setPdfJsLoader(() => (pdfjs ??= import('pdfjs-dist').then((m) => {
  m.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
  return m;
})));

setOcrWorkerFactory(async (lang, onProgress) => {
  const Tesseract = await import('tesseract.js');
  return Tesseract.createWorker(lang, 1, {
    workerPath: '/tess/worker.min.js',
    langPath: '/tess',
    logger: (m) => m.status === 'recognizing text' && onProgress?.(m.progress),
  });
});
```

Nothing is fetched because you imported the package — loaders run the first time
a feature that needs them is used. Everything else (merge, split, rotate,
compress, typeset, table detection) works with no configuration at all.

A few features import an optional peer the first time they run. Install the
ones you use:

| Feature | Install |
|---|---|
| Rendering, text extraction, PDF to Word/Excel | `pdfjs-dist` |
| OCR | `tesseract.js` |
| PDF to Word | `docx` |
| PDF to Excel | `xlsx` |
| Markdown to PDF | `marked` |
| Several outputs as one `.zip` | `jszip` |
| Typesetting non-Latin text | `@pdf-lib/fontkit` |

## Converting to Word and Excel

```ts
import { pdfToWord, pdfToExcel } from 'browser-pdf';

const docx = await pdfToWord({ bytes });   // needs pdf.js
const xlsx = await pdfToExcel({ bytes });
```

**Be honest with your users about what this is.** It recovers the *text* and the
*tables*, not a visual copy of the page. Multi-column layouts, headers and
footers, and text inside images come out simplified. That is inherent to
client-side extraction, not a bug to be fixed later — reconstructing a layout
faithfully needs the server-side analysis the big converters run.

It does detect real tables, which is the difference between a usable document
and a stack of loose paragraphs in column order. Invoices and reports survive.

One limit worth knowing: some PDFs have the words already run together in their
own text layer (`"theCompanies Act 2013"` as a single string). No extractor can
recover a space that was never written into the file — Adobe included.

## Typesetting

A small block model, plus a typesetter that turns it into a PDF:

```ts
import { textToBlocks, markdownToBlocks, typesetBlocks } from 'browser-pdf';

const pdf = await typesetBlocks(textToBlocks(someText), { title: 'Report' });
```

`textToBlocks` recovers structure from *plain* text — setext underlines, CAPS
and `Label:` headings, `-` and `1.` lists with nesting, `>` quotes, indented
code — because people do format plain text, and throwing that away produces the
undifferentiated wall of body copy every text-to-PDF tool is known for.

## What it does not do

- **No rendering to canvas beyond thumbnails.** Use pdf.js directly for a viewer.
- **No digital signature validation.** `sign` here means drawing a signature,
  not PKI.
- **Latin text embeds no fonts** (the standard 14 cover it). Other scripts need
  a Unicode face, which is the one place typesetting touches the network.

## Licence

MIT.

---

Maintained alongside [7busyboss.com](https://7busyboss.com), where this engine
runs about twenty PDF tools in production — which is also the easiest way to try
it without installing anything.
