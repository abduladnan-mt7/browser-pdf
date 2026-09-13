// Block typesetter — DocBlock[] → PDF bytes via @cantoo/pdf-lib. Consumed by
// the html/markdown/text→PDF converters. Word-wraps styled inline runs, breaks
// pages (headings keep-with-next), draws lists, quotes, code, tables, images,
// and real Link annotations. Blocks may carry a BlockStyle (computed-CSS
// extraction from the html path): alignment, font size, colors, spacing,
// heading rules, split rows (flex space-between), borderless tables with
// measured column widths. Styleless blocks (markdown/text paths) render with
// the same defaults as before BlockStyle existed.
//
// Runs in the browser AND in the Node eval harness: clean-Latin documents use
// StandardFonts (no fetches); other scripts embed the self-hosted Noto TTF via
// fonts.ts, and when that's unavailable (Node) text is sanitized to WinAnsi so
// typesetting never hard-fails.

import {
  PDFArray,
  PDFDocument,
  PDFFont,
  PDFName,
  PDFPage,
  PDFString,
  StandardFonts,
  rgb,
  type RGB,
} from '@cantoo/pdf-lib';
import type { BlockStyle, DocBlock, InlineRun } from '../docmodel';
import { detectScript, embedFontFor } from '../fonts';

export interface TypesetOptions {
  /** Default 'a4'. */
  pageSize?: 'a4' | 'letter';
  /** PDF metadata title. */
  title?: string;
  /** Page margin in points. Default DEFAULT_MARGIN (72 = 1in). */
  marginPt?: number;
  /**
   * PDF metadata Producer / Creator.
   *
   * Defaults to this library's name, NOT to whoever happens to be maintaining
   * it. Stamping a fixed brand into every document a consumer generates would
   * put a stranger's domain in the metadata of their client's deliverables,
   * which is a good reason never to adopt a library — set these to your own
   * product, or to '' to leave both unset.
   */
  producer?: string;
  creator?: string;
}

// ——— layout constants ————————————————————————————————————————————————————
const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const;

// MEASURE. A4 is 595pt wide; at the old 54pt (0.75in) margins that left a
// 487pt text column, and Helvetica at 11pt averages ~5.5pt per character — so
// roughly 88 characters per line. Typography puts comfortable reading at
// 60-75, and an over-long measure is the single thing that most makes a
// document read as untyped rather than typeset: the eye loses its place
// returning to the next line. 72pt (1in) is both the standard every office
// document uses and a ~82-character measure, which is the most improvement
// available without also changing the body size and reflowing every document
// the site has ever produced.
export const DEFAULT_MARGIN = 72; // 1in
const BODY_SIZE = 11;
const LINE_RATIO = 1.5;

// Space BEFORE a heading is what groups a document into sections — it is the
// reader's cue that one idea ended and another began, and it does more for
// perceived quality than the heading's own size. These were tight enough that
// headings floated between paragraphs instead of introducing them. Sizes step
// more decisively too: at 11pt body, an old 14pt h3 was barely distinguishable
// from bold body text.
const HEADING = {
  1: { size: 23, before: 20 },
  2: { size: 17, before: 17 },
  3: { size: 13, before: 13 },
} as const;
const CODE_SIZE = 9.5;
const TABLE_SIZE = 9.5;
const CELL_PAD = 4;
const MIN_COL = 40;

const INK = rgb(0.12, 0.12, 0.14);
const MUTED = rgb(0.35, 0.35, 0.4);
const LINK_BLUE = rgb(0.05, 0.35, 0.75);
const RULE_GRAY = rgb(0.8, 0.8, 0.82);
const QUOTE_BAR = rgb(0.72, 0.72, 0.75);
const CODE_BG = rgb(0.95, 0.95, 0.96);
const TABLE_GRID = rgb(0.75, 0.75, 0.78);
const TABLE_HEAD_BG = rgb(0.94, 0.94, 0.96);

/** '#rrggbb' → pdf-lib RGB (undefined for anything unparsable). */
function hexToRgb(hex: string | undefined): RGB | undefined {
  if (!hex) return undefined;
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255);
}

interface FontSet {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  mono: PDFFont;
  /** Unicode font for tokens the WinAnsi StandardFonts can't encode. When
   *  present, only those tokens switch font — bold/italic stay real for the
   *  rest of the document instead of collapsing to a single Noto weight. */
  fallback?: PDFFont;
}

// WinAnsi (CP1252): printable ASCII, Latin-1 letters, and the CP1252 extras.
// Anything else becomes '?' when we're stuck with StandardFonts.
const NON_WINANSI =
  /[^\x20-\x7e\xa0-\xffŒœŠšŸŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™]/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Stateless non-WinAnsi check (NON_WINANSI is /g — .test() on it would
 *  carry lastIndex between calls and intermittently lie). */
function hasNonWinAnsi(s: string): boolean {
  NON_WINANSI.lastIndex = 0;
  return NON_WINANSI.test(s);
}

function docText(blocks: DocBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if ('runs' in b) parts.push(...b.runs.map((r) => r.text));
    else if (b.kind === 'splitRow') parts.push(...[...b.left, ...b.right].map((r) => r.text));
    else if (b.kind === 'code') parts.push(b.text);
    else if (b.kind === 'table') parts.push(...b.header, ...b.rows.flat());
    else if (b.kind === 'image' && b.caption) parts.push(b.caption);
  }
  return parts.join(' ');
}

async function makeFonts(
  doc: PDFDocument,
  blocks: DocBlock[],
): Promise<{ fonts: FontSet; clean: (s: string) => string }> {
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const all = docText(blocks).replace(CONTROL, '');
  const winAnsiOk = !hasNonWinAnsi(all);
  const stdSet = async (): Promise<FontSet> => ({
    regular: helv,
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
  });
  // CONTROL deliberately spares the newline (its ranges skip U+000A) so that a
  // code block keeps its newlines as far as drawCodeBlock, which splits on
  // them. By the time any string reaches a draw call that split has already
  // happened, so a newline still present here is not a line break — it is a
  // stray that would be drawn as a glyph, or rewritten to '?' by the degraded
  // path below. Collapse it to a space instead.
  const inline = (s: string) => s.replace(CONTROL, '').replace(/\r?\n/g, ' ');

  if (winAnsiOk) {
    return { fonts: await stdSet(), clean: inline };
  }
  try {
    // Some characters fall outside WinAnsi (arrows, non-Latin scripts):
    // keep the real Helvetica bold/italic faces and embed Noto only as a
    // per-token fallback for the glyphs the standard fonts can't encode.
    const noto = await embedFontFor(doc, detectScript(all));
    return {
      fonts: { ...(await stdSet()), fallback: noto },
      clean: inline,
    };
  } catch {
    // No font fetch available (Node eval / offline miss): degrade, don't die.
    return { fonts: await stdSet(), clean: (s) => inline(s).replace(NON_WINANSI, '?') };
  }
}

// ——— line model ——————————————————————————————————————————————————————————
interface Seg {
  text: string;
  font: PDFFont;
  size: number;
  color: RGB;
  href?: string;
}
interface Line {
  segs: Seg[];
  width: number;
}

interface RunStyleOpts {
  fonts: FontSet;
  size: number;
  color: RGB;
  forceBold?: boolean;
}

function runFont(run: InlineRun, fonts: FontSet, forceBold?: boolean): PDFFont {
  if (run.code) return fonts.mono;
  const bold = run.bold || forceBold;
  if (bold && run.italic) return fonts.boldItalic;
  if (bold) return fonts.bold;
  if (run.italic) return fonts.italic;
  return fonts.regular;
}

/** Greedy word-wrap of styled runs into lines of positioned segments. */
function wrapRuns(
  runs: InlineRun[],
  maxWidth: number,
  opts: RunStyleOpts,
  clean: (s: string) => string,
): Line[] {
  const lines: Line[] = [];
  let segs: Seg[] = [];
  let width = 0;

  const flush = () => {
    // Trim trailing whitespace-only tail of the line.
    while (segs.length && !segs[segs.length - 1].text.trim()) {
      width -= segs[segs.length - 1].font.widthOfTextAtSize(segs[segs.length - 1].text, segs[segs.length - 1].size);
      segs.pop();
    }
    lines.push({ segs, width });
    segs = [];
    width = 0;
  };
  const push = (text: string, font: PDFFont, w: number, run: InlineRun) => {
    const color = hexToRgb(run.color) ?? (run.href ? LINK_BLUE : opts.color);
    const prev = segs[segs.length - 1];
    if (prev && prev.font === font && prev.href === run.href && prev.color === color) prev.text += text;
    else segs.push({ text, font, size: opts.size, color, href: run.href });
    width += w;
  };

  for (const run of runs) {
    const styleFont = runFont(run, opts.fonts, opts.forceBold);
    const tokens = clean(run.text).split(/(\s+)/).filter((t) => t.length);
    for (const tok of tokens) {
      // Tokens the standard font can't encode switch to the Unicode fallback.
      const font = opts.fonts.fallback && hasNonWinAnsi(tok) ? opts.fonts.fallback : styleFont;
      const isSpace = !tok.trim();
      const w = font.widthOfTextAtSize(tok, opts.size);
      if (!isSpace && width + w > maxWidth && segs.some((s) => s.text.trim())) flush();
      if (isSpace && segs.length === 0) continue; // no leading spaces on a line
      // A single token wider than the line: hard-split by characters.
      if (!isSpace && w > maxWidth) {
        let piece = '';
        for (const ch of tok) {
          const pw = font.widthOfTextAtSize(piece + ch, opts.size);
          if (pw > maxWidth && piece) {
            push(piece, font, font.widthOfTextAtSize(piece, opts.size), run);
            flush();
            piece = ch;
          } else piece += ch;
        }
        if (piece) push(piece, font, font.widthOfTextAtSize(piece, opts.size), run);
        continue;
      }
      push(tok, font, w, run);
    }
  }
  if (segs.length) flush();
  if (lines.length === 0) lines.push({ segs: [], width: 0 });
  return lines;
}

// ——— page cursor —————————————————————————————————————————————————————————
class Cursor {
  page!: PDFPage;
  y = 0;
  constructor(
    readonly doc: PDFDocument,
    readonly pageW: number,
    readonly pageH: number,
    readonly margin: number,
  ) {
    this.newPage();
  }
  newPage(): void {
    this.page = this.doc.addPage([this.pageW, this.pageH]);
    this.y = this.pageH - this.margin;
  }
  get atTop(): boolean {
    return this.y >= this.pageH - this.margin - 0.01;
  }
  get spaceLeft(): number {
    return this.y - this.margin;
  }
  /** Ensure at least h points of vertical space, else start a new page. */
  need(h: number): void {
    if (this.spaceLeft < h) this.newPage();
  }
  gap(h: number): void {
    if (!this.atTop) this.y = Math.max(this.y - h, this.margin);
  }
}

function drawLine(
  cur: Cursor,
  line: Line,
  x: number,
  lineH: number,
  size: number,
  align: 'left' | 'center' | 'right' = 'left',
  boxW = 0,
): void {
  if (cur.spaceLeft < lineH) cur.newPage();
  cur.y -= lineH;
  const baseline = cur.y + (lineH - size) / 2; // vertically center the glyphs in the line box
  let dx = x;
  if (align === 'center') dx = x + Math.max(0, (boxW - line.width) / 2);
  else if (align === 'right') dx = x + Math.max(0, boxW - line.width);
  for (const seg of line.segs) {
    if (seg.text.trim()) {
      cur.page.drawText(seg.text, { x: dx, y: baseline, size: seg.size, font: seg.font, color: seg.color });
    }
    const w = seg.font.widthOfTextAtSize(seg.text, seg.size);
    if (seg.href && seg.text.trim()) {
      cur.page.drawLine({
        start: { x: dx, y: baseline - 1.5 },
        end: { x: dx + w, y: baseline - 1.5 },
        thickness: 0.5,
        color: seg.color,
      });
      addLinkAnnotation(cur.doc, cur.page, seg.href, dx, baseline - 2, w, seg.size + 3);
    }
    dx += w;
  }
}

function addLinkAnnotation(
  doc: PDFDocument,
  page: PDFPage,
  href: string,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const ann = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [x, y, x + w, y + h],
    Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: PDFString.of(href) },
  });
  const ref = doc.context.register(ann);
  const existing = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (existing) existing.push(ref);
  else page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
}

// ——— block renderers —————————————————————————————————————————————————————

function drawRuns(
  cur: Cursor,
  runs: InlineRun[],
  x: number,
  maxW: number,
  style: RunStyleOpts,
  clean: (s: string) => string,
  block?: BlockStyle,
): void {
  const lineH = style.size * (block?.lineHeight ?? LINE_RATIO);
  for (const line of wrapRuns(runs, maxW, style, clean)) {
    drawLine(cur, line, x, lineH, style.size, block?.align ?? 'left', maxW);
  }
}

/** Flex space-between line: left runs wrap, right runs sit right-aligned on
 *  the first baseline (the resume "role ⟷ date" pattern). */
function drawSplitRow(
  cur: Cursor,
  block: Extract<DocBlock, { kind: 'splitRow' }>,
  fonts: FontSet,
  clean: (s: string) => string,
): void {
  const contentW = cur.pageW - 2 * cur.margin;
  const size = block.style?.sizePt ?? BODY_SIZE;
  const color = hexToRgb(block.style?.color) ?? INK;
  const lineH = size * (block.style?.lineHeight ?? LINE_RATIO);
  const opts: RunStyleOpts = { fonts, size, color };

  // The right side never wraps — measure it as one line.
  const rightLine = wrapRuns(block.right, Number.MAX_SAFE_INTEGER, opts, clean)[0];
  const rightW = rightLine.width;
  const leftMax = Math.max(60, contentW - rightW - 8);
  const leftLines = wrapRuns(block.left, leftMax, opts, clean);

  cur.need(lineH);
  drawLine(cur, leftLines[0], cur.margin, lineH, size);
  // Right side shares the first line's box: after drawLine, cur.y is that
  // line's bottom, so the baseline math below matches drawLine's exactly.
  const baseline = cur.y + (lineH - size) / 2;
  let dx = cur.margin + contentW - rightW;
  for (const seg of rightLine.segs) {
    if (seg.text.trim()) {
      cur.page.drawText(seg.text, { x: dx, y: baseline, size: seg.size, font: seg.font, color: seg.color });
      if (seg.href) addLinkAnnotation(cur.doc, cur.page, seg.href, dx, baseline - 2, seg.font.widthOfTextAtSize(seg.text, seg.size), seg.size + 3);
    }
    dx += seg.font.widthOfTextAtSize(seg.text, seg.size);
  }
  for (const line of leftLines.slice(1)) drawLine(cur, line, cur.margin, lineH, size);
}

function drawCodeBlock(cur: Cursor, text: string, fonts: FontSet, clean: (s: string) => string): void {
  const lineH = CODE_SIZE * 1.4;
  const pad = 6;
  const contentW = cur.pageW - 2 * cur.margin;
  const charW = fonts.mono.widthOfTextAtSize('M', CODE_SIZE);
  const maxChars = Math.max(8, Math.floor((contentW - 2 * pad) / charW));

  // Split BEFORE cleaning. clean() exists to make text drawable, and in the
  // degraded WinAnsi path it rewrites everything outside CP1252 as '?' —
  // including the newlines. Cleaning first therefore destroyed the very
  // separators this line splits on, and a multi-line code block came out as
  // one long line with a literal '?' where each break had been.
  const srcLines = text.replace(/\t/g, '  ').split('\n').map(clean);
  const lines: string[] = [];
  for (const l of srcLines) {
    if (l.length <= maxChars) lines.push(l);
    else for (let i = 0; i < l.length; i += maxChars) lines.push(l.slice(i, i + maxChars));
  }
  if (!lines.length) lines.push('');

  let i = 0;
  while (i < lines.length) {
    cur.need(lineH + 2 * pad);
    const fit = Math.max(1, Math.floor((cur.spaceLeft - 2 * pad) / lineH));
    const chunk = lines.slice(i, i + fit);
    const boxH = chunk.length * lineH + 2 * pad;
    cur.page.drawRectangle({
      x: cur.margin,
      y: cur.y - boxH,
      width: contentW,
      height: boxH,
      color: CODE_BG,
    });
    cur.y -= pad;
    for (const l of chunk) {
      cur.y -= lineH;
      const lineFont = fonts.fallback && hasNonWinAnsi(l) ? fonts.fallback : fonts.mono;
      if (l) cur.page.drawText(l, { x: cur.margin + pad, y: cur.y + (lineH - CODE_SIZE) / 2, size: CODE_SIZE, font: lineFont, color: INK });
    }
    cur.y -= pad;
    i += chunk.length;
    if (i < lines.length) cur.newPage();
  }
}

function measureCell(runs: InlineRun[], fonts: FontSet, size: number, forceBold: boolean): number {
  let total = 0;
  let widestWord = 0;
  for (const r of runs) {
    const styleFont = runFont(r, fonts, forceBold);
    for (const word of r.text.split(/(\s+)/)) {
      if (!word) continue;
      const font = fonts.fallback && hasNonWinAnsi(word) ? fonts.fallback : styleFont;
      const w = font.widthOfTextAtSize(word, size);
      total += w;
      if (word.trim()) widestWord = Math.max(widestWord, w);
    }
  }
  return Math.max(total, widestWord);
}

function drawTable(
  cur: Cursor,
  block: Extract<DocBlock, { kind: 'table' }>,
  fonts: FontSet,
  clean: (s: string) => string,
): void {
  const contentW = cur.pageW - 2 * cur.margin;
  const size = block.style?.sizePt ?? TABLE_SIZE;
  const borderless = !!block.borderless;
  const nCols = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1);

  // Cells as runs: styled cells from the html path win; plain strings otherwise.
  const cellRuns = (c: number, r: number | null): InlineRun[] => {
    if (r === null) {
      return block.headerRuns?.[c] ?? (block.header[c] ? [{ text: block.header[c] }] : []);
    }
    return block.rowRuns?.[r]?.[c] ?? (block.rows[r]?.[c] ? [{ text: block.rows[r][c] }] : []);
  };
  const cleanRuns = (runs: InlineRun[]) => runs.map((x) => ({ ...x, text: clean(x.text) }));

  // Column widths: measured hints from the html path when available,
  // otherwise natural content widths; both clamped into the content box.
  let widths: number[];
  if (block.colWidths && block.colWidths.length === nCols && block.colWidths.some((w) => w > 0)) {
    const hintTotal = block.colWidths.reduce((a, b) => a + b, 0) || 1;
    const target = Math.min(contentW, hintTotal * 0.75); // px → pt, capped at content width
    widths = block.colWidths.map((w) => (w / hintTotal) * target);
  } else {
    const natural = Array.from({ length: nCols }, (_, c) => {
      let w = measureCell(cleanRuns(cellRuns(c, null)), fonts, size, true);
      for (let r = 0; r < block.rows.length; r++) {
        w = Math.max(w, measureCell(cleanRuns(cellRuns(c, r)), fonts, size, false));
      }
      return w + 2 * CELL_PAD;
    });
    const total = natural.reduce((a, b) => a + b, 0);
    widths = natural;
    if (total > contentW) {
      const scale = contentW / total;
      widths = natural.map((w) => Math.max(MIN_COL, w * scale));
      const over = widths.reduce((a, b) => a + b, 0) - contentW;
      if (over > 0) {
        const flexible = widths.filter((w) => w > MIN_COL).reduce((a, b) => a + b, 0);
        widths = widths.map((w) => (w > MIN_COL ? w - (over * w) / flexible : w));
      }
    }
  }

  const lineH = size * (block.style?.lineHeight ?? 1.35);
  const pad = borderless ? 1 : CELL_PAD;
  const wrapCell = (runs: InlineRun[], colW: number, forceBold: boolean): Line[] =>
    wrapRuns(runs, Math.max(20, colW - 2 * pad), { fonts, size, color: hexToRgb(block.style?.color) ?? INK, forceBold }, clean);

  const drawRow = (cells: InlineRun[][], isHeader: boolean): void => {
    const wrapped = cells.map((c, i) => wrapCell(c, widths[i], isHeader));
    const rowH = Math.max(...wrapped.map((w) => w.length), 1) * lineH + 2 * pad;
    cur.need(rowH);
    const top = cur.y;
    let x = cur.margin;
    for (let c = 0; c < cells.length; c++) {
      if (!borderless) {
        cur.page.drawRectangle({
          x,
          y: top - rowH,
          width: widths[c],
          height: rowH,
          borderWidth: 0.5,
          borderColor: TABLE_GRID,
          color: isHeader ? TABLE_HEAD_BG : undefined,
        });
      }
      let ty = top - pad;
      for (const line of wrapped[c]) {
        ty -= lineH;
        let dx = x + pad;
        for (const seg of line.segs) {
          if (seg.text.trim()) {
            cur.page.drawText(seg.text, { x: dx, y: ty + (lineH - size) / 2, size: seg.size, font: seg.font, color: seg.color });
            if (seg.href) addLinkAnnotation(cur.doc, cur.page, seg.href, dx, ty + (lineH - size) / 2 - 2, seg.font.widthOfTextAtSize(seg.text, seg.size), seg.size + 3);
          }
          dx += seg.font.widthOfTextAtSize(seg.text, seg.size);
        }
      }
      x += widths[c];
    }
    cur.y = top - rowH;
  };

  const headCells = Array.from({ length: nCols }, (_, c) => cleanRuns(cellRuns(c, null)));
  const hasHeader = headCells.some((c) => c.some((r) => r.text.trim()));
  if (hasHeader) drawRow(headCells, true);
  for (let r = 0; r < block.rows.length; r++) {
    const cells = Array.from({ length: nCols }, (_, c) => cleanRuns(cellRuns(c, r)));
    const wrapped = cells.map((c, i) => wrapCell(c, widths[i], false));
    const rowH = Math.max(...wrapped.map((w) => w.length), 1) * lineH + 2 * pad;
    if (cur.spaceLeft < rowH) {
      cur.newPage();
      if (hasHeader && !borderless) drawRow(headCells, true); // repeat header on continuation pages
    }
    drawRow(cells, false);
  }
}

async function drawImage(
  cur: Cursor,
  block: Extract<DocBlock, { kind: 'image' }>,
  fonts: FontSet,
  clean: (s: string) => string,
): Promise<void> {
  let img;
  try {
    img = block.format === 'png' ? await cur.doc.embedPng(block.bytes) : await cur.doc.embedJpg(block.bytes);
  } catch {
    return; // a broken image must not kill the document
  }
  const contentW = cur.pageW - 2 * cur.margin;
  const maxH = cur.pageH - 2 * cur.margin - (block.caption ? 16 : 0);
  let w = Math.min(img.width, contentW);
  let h = (img.height / img.width) * w;
  if (h > maxH) {
    h = maxH;
    w = (img.width / img.height) * h;
  }
  const captionH = block.caption ? 16 : 0;
  cur.need(h + captionH);
  cur.y -= h;
  cur.page.drawImage(img, { x: cur.margin + (contentW - w) / 2, y: cur.y, width: w, height: h });
  if (block.caption) {
    cur.y -= 13;
    const text = clean(block.caption);
    const tw = fonts.regular.widthOfTextAtSize(text, 9);
    cur.page.drawText(text, { x: cur.margin + (contentW - tw) / 2, y: cur.y, size: 9, font: fonts.regular, color: MUTED });
  }
}

// ——— entry point —————————————————————————————————————————————————————————

/** Typeset blocks into a finished PDF. See TypesetOptions. */
export async function typesetBlocks(blocks: DocBlock[], opts: TypesetOptions = {}): Promise<Uint8Array> {
  const [pageW, pageH] = PAGE_SIZES[opts.pageSize ?? 'a4'];
  const doc = await PDFDocument.create();
  if (opts.title) doc.setTitle(opts.title);
  const producer = opts.producer ?? 'browser-pdf';
  const creator = opts.creator ?? 'browser-pdf';
  if (producer) doc.setProducer(producer);
  if (creator) doc.setCreator(creator);

  const { fonts, clean } = await makeFonts(doc, blocks);
  const cur = new Cursor(doc, pageW, pageH, opts.marginPt ?? DEFAULT_MARGIN);
  const contentW = pageW - 2 * cur.margin;
  const bodyLineH = BODY_SIZE * LINE_RATIO;

  for (const block of blocks) {
    const bs: BlockStyle | undefined = 'style' in block ? block.style : undefined;
    const blockColor = hexToRgb(bs?.color);
    switch (block.kind) {
      case 'heading': {
        const size = bs?.sizePt ?? HEADING[block.level].size;
        const before = bs?.spaceBefore ?? HEADING[block.level].before;
        // Keep-with-next: room for the heading line + two body lines,
        // otherwise the heading moves to the next page.
        if (cur.spaceLeft < before + size * LINE_RATIO + 2 * bodyLineH) cur.newPage();
        else cur.gap(before);
        drawRuns(cur, block.runs, cur.margin, contentW, { fonts, size, color: blockColor ?? INK, forceBold: true }, clean, bs);
        if (bs?.rule) {
          cur.y -= 1.5;
          cur.page.drawLine({
            start: { x: cur.margin, y: cur.y },
            end: { x: pageW - cur.margin, y: cur.y },
            thickness: 0.8,
            color: blockColor ?? INK,
          });
        }
        cur.gap(bs?.spaceAfter ?? 6);
        break;
      }
      case 'paragraph': {
        const size = bs?.sizePt ?? BODY_SIZE;
        if (bs?.spaceBefore) cur.gap(bs.spaceBefore);
        drawRuns(cur, block.runs, cur.margin, contentW, { fonts, size, color: blockColor ?? INK }, clean, bs);
        cur.gap(bs?.spaceAfter ?? 8);
        break;
      }
      case 'splitRow':
        if (bs?.spaceBefore) cur.gap(bs.spaceBefore);
        drawSplitRow(cur, block, fonts, clean);
        cur.gap(bs?.spaceAfter ?? 2);
        break;
      case 'listItem': {
        const size = bs?.sizePt ?? BODY_SIZE;
        const lineH = size * (bs?.lineHeight ?? LINE_RATIO);
        const indent = 18 + block.depth * 18;
        const marker = block.ordered ? `${block.index}.` : '•';
        cur.need(lineH);
        // The first wrapped line is guaranteed onto THIS page by need() above —
        // pin the marker to it even if later lines flow to the next page.
        const markerPage = cur.page;
        const markerY = cur.y;
        drawRuns(cur, block.runs, cur.margin + indent, contentW - indent, { fonts, size, color: blockColor ?? INK }, clean, bs);
        const cleanMarker = clean(marker);
        markerPage.drawText(cleanMarker, {
          x: cur.margin + indent - 14,
          y: markerY - lineH + (lineH - size) / 2,
          size,
          font: fonts.regular,
          color: blockColor ?? INK,
        });
        cur.gap(bs?.spaceAfter ?? 4);
        break;
      }
      case 'blockquote': {
        const size = bs?.sizePt ?? BODY_SIZE;
        cur.need(size * LINE_RATIO);
        const startPage = cur.page;
        const top = cur.y;
        drawRuns(cur, block.runs, cur.margin + 12, contentW - 12, { fonts, size, color: blockColor ?? MUTED }, clean, bs);
        // Quote crossed a page: the bar on the current page runs from the top
        // margin; otherwise from where the quote started.
        const barTop = cur.page === startPage ? top : pageH - cur.margin;
        cur.page.drawRectangle({ x: cur.margin, y: cur.y, width: 3, height: Math.max(barTop - cur.y, size * LINE_RATIO), color: QUOTE_BAR });
        cur.gap(bs?.spaceAfter ?? 8);
        break;
      }
      case 'code':
        drawCodeBlock(cur, block.text, fonts, clean);
        cur.gap(8);
        break;
      case 'table':
        if (bs?.spaceBefore) cur.gap(bs.spaceBefore);
        drawTable(cur, block, fonts, clean);
        cur.gap(bs?.spaceAfter ?? 10);
        break;
      case 'image':
        await drawImage(cur, block, fonts, clean);
        cur.gap(10);
        break;
      case 'hr':
        cur.gap(10);
        cur.need(1);
        cur.page.drawLine({
          start: { x: cur.margin, y: cur.y },
          end: { x: pageW - cur.margin, y: cur.y },
          thickness: 0.5,
          color: RULE_GRAY,
        });
        cur.gap(10);
        break;
    }
  }

  return doc.save();
}
