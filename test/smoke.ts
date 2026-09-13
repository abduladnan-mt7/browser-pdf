// Standalone test suite — `npm test`, no browser and no fixtures on disk.
//
// Every PDF here is built at runtime with pdf-lib, so the tests are
// deterministic and the repo stays free of binary fixtures nobody can review.
//
// This is a subset. The engine's full harness (131 assertions, including image
// re-encoding, AcroForm filling, encryption round-trips and typesetting
// operator-level checks) runs in the application this was extracted from,
// because several of those need a DOM. What is covered here is everything that
// can run in plain Node — which is most of the logic worth protecting.

import assert from 'node:assert/strict';
import { PDFDocument } from '@cantoo/pdf-lib';

import { parsePageRanges, tryParsePageRanges } from '../src/ranges';
import { createSession, addSource, buildPdf, removePages, rotatePages, duplicatePage } from '../src/session';
import { textToBlocks } from '../src/docmodel';
import { typesetBlocks, DEFAULT_MARGIN } from '../src/ops/typeset';
import { detectTables } from '../src/tables';
import { reconstructBlocks, type TextItem } from '../src/reconstruct';
import { PdfEngineNotConfiguredError } from '../src/runtime';
import { getPdfjsDoc } from '../src/render';

let pass = 0;
const failures: string[] = [];
function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => { pass++; console.log(`  ok  ${name}`); },
      (e) => { failures.push(name); console.error(`  FAIL ${name}\n       ${e.message}`); },
    );
}

async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([400, 600]).drawText(`Page ${i + 1}`, { x: 40, y: 550, size: 24 });
  return doc.save();
}

async function main() {
  console.log('page ranges');
  await it('parses a single page', () => assert.deepEqual(parsePageRanges('3', 10), [3]));
  await it('parses a range', () => assert.deepEqual(parsePageRanges('2-5', 10), [2, 3, 4, 5]));
  await it('open-ended "7-" runs to the last page', () => assert.deepEqual(parsePageRanges('7-', 9), [7, 8, 9]));
  await it('open-start "-3" runs from the first', () => assert.deepEqual(parsePageRanges('-3', 10), [1, 2, 3]));
  await it('dedupes and sorts a mixed list', () => assert.deepEqual(parsePageRanges('5, 1-3, 2', 10), [1, 2, 3, 5]));
  await it('rejects a backwards range', () => assert.equal(tryParsePageRanges('5-2', 10), null));
  await it('rejects a page beyond the document', () => assert.equal(tryParsePageRanges('11', 10), null));
  await it('rejects nonsense', () => assert.equal(tryParsePageRanges('abc', 10), null));

  console.log('\ndocument assembly');
  await it('merges pages from several sources', async () => {
    const s = createSession();
    await addSource(s, { name: 'a.pdf', bytes: await makePdf(3), mime: 'application/pdf' });
    await addSource(s, { bytes: await makePdf(2) }); // name/mime omitted on purpose: sniffed from the bytes
    assert.equal(s.pages.length, 5);
    const out = await PDFDocument.load(await buildPdf(s));
    assert.equal(out.getPageCount(), 5);
  });
  await it('removes pages', async () => {
    const s = createSession();
    await addSource(s, { bytes: await makePdf(5) });
    removePages(s, [s.pages[0].id, s.pages[4].id]);
    assert.equal(s.pages.length, 3);
  });
  await it('accumulates rotation to 180 rather than overwriting', async () => {
    const s = createSession();
    await addSource(s, { bytes: await makePdf(1) });
    rotatePages(s, [s.pages[0].id], 90);
    rotatePages(s, [s.pages[0].id], 90);
    const out = await PDFDocument.load(await buildPdf(s));
    assert.equal(out.getPage(0).getRotation().angle, 180);
  });
  await it('duplicates a page', async () => {
    const s = createSession();
    await addSource(s, { bytes: await makePdf(2) }); // name/mime omitted on purpose: sniffed from the bytes
    duplicatePage(s, s.pages[0].id);
    assert.equal(s.pages.length, 3);
  });

  console.log('\nplain-text structure recovery');
  const kinds = (t: string) => textToBlocks(t).map((b) => b.kind).join(',');
  await it('one list item per line, not one run-on paragraph', () => {
    const b = textToBlocks('- apples\n- pears\n- flour');
    assert.equal(b.filter((x) => x.kind === 'listItem').length, 3);
  });
  await it('hard-wrapped prose still collapses to one paragraph', () => {
    const b = textToBlocks('The quick brown fox\njumps over the lazy dog.');
    assert.equal(b.length, 1);
    assert.equal((b[0] as { runs: { text: string }[] }).runs[0].text, 'The quick brown fox jumps over the lazy dog.');
  });
  await it('keeps ordered-list numbering', () => {
    const b = textToBlocks('1. first\n2. second\n3. third');
    assert.deepEqual(b.map((x) => (x.kind === 'listItem' ? x.index : 0)), [1, 2, 3]);
  });
  await it('maps indentation to nesting depth', () => {
    const b = textToBlocks('- top\n  - child\n- back');
    assert.deepEqual(b.map((x) => (x.kind === 'listItem' ? x.depth : -1)), [0, 1, 0]);
  });
  await it('reads a CAPS line as a heading', () => assert.equal(kinds('SHIPPING ADDRESS\n\nbody'), 'heading,paragraph'));
  await it('does NOT make an all-caps document all headings', () => {
    const b = textToBlocks('INVOICE FOR SERVICES\nPAYMENT DUE ON RECEIPT\nTHANK YOU');
    assert.ok(b.every((x) => x.kind !== 'heading'));
  });
  await it('leaves an ordinary sentence as a paragraph', () => assert.equal(kinds('This is a normal sentence.'), 'paragraph'));
  await it('recognises quotes, rules and indented code', () => {
    assert.equal(kinds('> quoted'), 'blockquote');
    assert.equal(kinds('above\n\n***\n\nbelow'), 'paragraph,hr,paragraph');
    assert.equal(kinds('    const x = 1;'), 'code');
  });

  console.log('\ntypesetting');
  await it('produces a loadable PDF', async () => {
    const bytes = await typesetBlocks(textToBlocks('TITLE\n\nSome body copy.\n\n- one\n- two'));
    assert.ok((await PDFDocument.load(bytes)).getPageCount() >= 1);
  });
  await it('defaults to a 1in margin', () => assert.equal(DEFAULT_MARGIN, 72));
  await it('keeps code-block line breaks instead of welding them', async () => {
    const b = textToBlocks('    const a = 1;\n    const b = 2;');
    assert.equal(b.length, 1);
    assert.ok((b[0] as { text: string }).text.includes('\n'));
  });

  console.log('\ntable detection');
  const tt = (str: string, x: number, y: number, h = 10) => ({ str, x, y, w: str.length * 6, h });
  await it('finds a 3x3 grid and places cells in the right columns', () => {
    const t = detectTables([
      tt('Name', 50, 700), tt('Qty', 150, 700), tt('Price', 250, 700),
      tt('Apple', 50, 680), tt('2', 150, 680), tt('10', 250, 680),
      tt('Banana', 50, 660), tt('5', 150, 660), tt('20', 250, 660),
    ]);
    assert.equal(t.length, 1);
    assert.deepEqual(t[0].rows[0], ['Name', 'Qty', 'Price']);
  });
  await it('reports the band a table occupies, so callers can strip its cells', () => {
    const t = detectTables([
      tt('A', 50, 700), tt('B', 150, 700),
      tt('C', 50, 680), tt('D', 150, 680),
      tt('E', 50, 660), tt('F', 150, 660),
    ]);
    assert.ok(t[0].yTop > t[0].yBottom);
  });
  await it('does not invent a table out of prose', () => {
    assert.equal(detectTables([tt('Just a sentence here', 50, 700), tt('and another one', 50, 680)]).length, 0);
  });

  console.log('\ntext reconstruction');
  await it('inserts a space when x jumps backwards on one baseline', () => {
    const items: TextItem[] = [
      { str: 'The Act means the', x: 297, y: 480, w: 195, h: 10, fontSize: 10, bold: false },
      { str: 'Companies Act 2013', x: 297, y: 480, w: 212, h: 10, fontSize: 10, bold: false },
    ];
    const text = reconstructBlocks([items])[0]?.[0]?.text ?? '';
    assert.ok(text.includes('the Companies'), text);
  });
  await it('does not split a word at a sub-run boundary', () => {
    const items: TextItem[] = [
      { str: 'Compa', x: 100, y: 400, w: 30, h: 10, fontSize: 10, bold: false },
      { str: 'nies', x: 130.4, y: 400, w: 20, h: 10, fontSize: 10, bold: false },
    ];
    assert.ok((reconstructBlocks([items])[0]?.[0]?.text ?? '').includes('Companies'));
  });

  console.log('\nconfiguration');
  await it('explains itself when pdf.js was never wired up', async () => {
    // The source is never touched: the loader check happens first, which is the
    // point — a wiring mistake should not look like a problem with the file.
    const dummy = { id: 's1', name: 'x.pdf', kind: 'pdf', bytes: new Uint8Array(), mime: 'application/pdf', pageCount: 1 };
    await assert.rejects(
      () => getPdfjsDoc(dummy as unknown as Parameters<typeof getPdfjsDoc>[0]),
      (e: Error) => e instanceof PdfEngineNotConfiguredError && /setPdfJsLoader/.test(e.message),
    );
  });

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
