// Text-layout reconstruction for PDF→Word. Pure and dependency-free (no
// pdfjs, no docx, no DOM) so the heuristics run identically in the browser
// and in the Node eval harness. Input: positioned text items per page in PDF
// coordinate space (origin bottom-left, y grows UP, x/y = baseline start).
// Output: ordered document blocks per page — headings, paragraphs, bullets.
//
// This is deliberately a reconstruction, not a layout clone: multi-column
// pages, tables and text inside figures come out as plain reading-order
// paragraphs. The converter UI says so.

export interface TextItem {
  str: string;
  /** Baseline start, PDF points (origin bottom-left — larger y is HIGHER). */
  x: number;
  y: number;
  /** Advance width in points. */
  w: number;
  /** Glyph-box height in points (≈ font size). */
  h: number;
  fontSize: number;
  bold?: boolean;
}

export interface DocBlock {
  kind: 'heading1' | 'heading2' | 'paragraph' | 'bullet';
  text: string;
}

// ——— tuning knobs (all relative to font size, so they scale with the doc) ———

/** Items whose baselines differ by ≤ this × fontSize sit on one visual line. */
const LINE_Y_TOLERANCE = 0.4;
/** Horizontal gap > this × fontSize between items ⇒ insert a space when merging. */
const WORD_GAP = 0.25;
/** Lines ≤ this × fontSize apart vertically may belong to the same paragraph. */
const PARAGRAPH_GAP = 1.6;
/** A line reaching ≥ this fraction of the text width "hits the right margin". */
const MARGIN_FILL = 0.85;
/** Heading thresholds: line size ÷ page body median. */
const H1_RATIO = 1.5;
const H2_RATIO = 1.15;
/** Bold lines get a small ratio discount for heading2 (bold subheads). */
const H2_BOLD_RATIO = 1.05;
/** Font-size clusters count as "same size" within this relative tolerance. */
const SIZE_TOLERANCE = 0.2;
/** Longer than this is prose, not a heading, whatever the font size. */
const MAX_HEADING_CHARS = 120;
/** Bullet continuation lines must be indented ≥ this × fontSize past the marker. */
const BULLET_INDENT = 0.5;

/** Bullet markers: •, -, –, ▪ (plus close cousins ◦/·/*) or "12." / "12)". */
const BULLET_RE = /^(?:[•\-–▪◦·*]|\d{1,3}[.)])\s+/;

interface Line {
  text: string;
  y: number;
  minX: number;
  maxX: number;
  /** Char-count-dominant font size of the line. */
  fontSize: number;
  /** True when items covering the majority of the line's characters are bold. */
  bold: boolean;
}

/**
 * Reconstruct document blocks from positioned text items, one block list per
 * page. Pipeline: sort → group into visual lines → merge runs into line text
 * → classify (bullet/heading/paragraph via per-page font-size median) →
 * stitch adjacent lines into paragraphs (with hyphenation repair).
 */
export function reconstructBlocks(pages: TextItem[][]): DocBlock[][] {
  return pages.map((items) => blocksForPage(items));
}

function blocksForPage(items: TextItem[]): DocBlock[] {
  const lines = buildLines(items);
  if (lines.length === 0) return [];

  // Page text extents — the "margins" the paragraph heuristic measures against.
  const pageLeft = Math.min(...lines.map((l) => l.minX));
  const pageRight = Math.max(...lines.map((l) => l.maxX));

  // Body font size = median of line sizes. Median (not mean) so a big title
  // or tiny footer can't drag the body size; computed per page because front
  // matter and body pages often use different scales.
  const median = medianOf(lines.map((l) => l.fontSize));

  const blocks: DocBlock[] = [];
  let prevLine: Line | null = null; // last physical line consumed
  let anchorX = pageLeft; // minX of the line that STARTED the current block (bullet indent anchor)

  for (const line of lines) {
    const kind = classifyLine(line, median);
    const prev = blocks[blocks.length - 1];

    if (prev && prevLine && canJoin(prev.kind, kind, prevLine, anchorX, line, pageLeft, pageRight)) {
      prev.text = joinText(prev.text, line.text);
    } else {
      blocks.push({ kind, text: kind === 'bullet' ? line.text.replace(BULLET_RE, '') : line.text });
      anchorX = line.minX;
    }

    prevLine = line;
  }

  return blocks;
}

// ——— visual lines ———

/**
 * Group items into visual lines: sort top-to-bottom (descending y — PDF y
 * grows upward) then left-to-right, and greedily attach an item to the
 * current line while its baseline is within 0.4×fontSize of the line's —
 * tight enough to keep adjacent lines apart at single spacing, loose enough
 * to absorb superscripts and slightly wobbly baselines.
 */
function buildLines(items: TextItem[]): Line[] {
  const usable = items.filter((i) => i.str.trim().length > 0);
  const sorted = usable.slice().sort((a, b) => (Math.abs(a.y - b.y) > 0.5 ? b.y - a.y : a.x - b.x));

  const groups: TextItem[][] = [];
  let current: TextItem[] = [];
  let currentY = 0;
  for (const item of sorted) {
    const tol = LINE_Y_TOLERANCE * Math.max(item.fontSize, current[0]?.fontSize ?? item.fontSize);
    if (current.length > 0 && Math.abs(item.y - currentY) <= tol) {
      current.push(item);
    } else {
      if (current.length > 0) groups.push(current);
      current = [item];
      currentY = item.y;
    }
  }
  if (current.length > 0) groups.push(current);

  return groups.map(lineFromItems);
}

/**
 * Merge one line's items (re-sorted by x) into text. A space is inserted
 * when the horizontal gap between an item's end and the next item's start
 * exceeds 0.25×fontSize — smaller gaps are kerning/sub-run splits inside a
 * word and concatenate directly.
 */
function lineFromItems(group: TextItem[]): Line {
  const inOrder = group.slice().sort((a, b) => a.x - b.x);

  let text = '';
  let endX = -Infinity;
  let boldChars = 0;
  let totalChars = 0;
  // Char-count-dominant font size — so one big drop-cap doesn't set the
  // size of a body line.
  const sizeChars = new Map<number, number>();

  for (const item of inOrder) {
    const chars = item.str.trim().length;
    totalChars += chars;
    if (item.bold) boldChars += chars;
    const sizeKey = Math.round(item.fontSize * 2) / 2;
    sizeChars.set(sizeKey, (sizeChars.get(sizeKey) ?? 0) + chars);

    if (text.length === 0) {
      text = item.str;
    } else {
      const gap = item.x - endX;
      // A large forward gap is ordinary word spacing. A large BACKWARD jump is
      // something else entirely: the next item starts well before the previous
      // one ended, which cannot happen for text continuing along the same line.
      // It means pdfjs has emitted two different lines (or two columns of a
      // form) that landed on one baseline here — producers that stamp every
      // line at the same left margin do this constantly.
      //
      // Treating that as "no gap, so no space" welds the last word of one line
      // onto the first word of the next: "the" + "Companies Act" becomes
      // "theCompanies Act". Across a real filing that happens dozens of times
      // and is the single most damaging artefact in the converted text.
      //
      // Half a font size is the cutoff because genuine kerning and sub-run
      // splits overlap by fractions of a point, never by half an em.
      const backwards = gap < -0.5 * item.fontSize;
      const needSpace =
        (gap > WORD_GAP * item.fontSize || backwards) &&
        !text.endsWith(' ') &&
        !item.str.startsWith(' ');
      text += (needSpace ? ' ' : '') + item.str;
    }
    endX = Math.max(endX, item.x + item.w);
  }

  let fontSize = inOrder[0].fontSize;
  let best = -1;
  for (const [size, chars] of sizeChars) {
    if (chars > best) { best = chars; fontSize = size; }
  }

  return {
    text: text.replace(/\s+/g, ' ').trim(),
    y: inOrder[0].y,
    minX: Math.min(...inOrder.map((i) => i.x)),
    maxX: endX,
    fontSize,
    bold: totalChars > 0 && boldChars / totalChars > 0.5,
  };
}

// ——— classification ———

/**
 * Classify one line. Bullets win over headings (a large-font bulleted line
 * is still a list item). Headings come from font-size clustering against the
 * page's body median: ≥1.5× → heading1, ≥1.15× → heading2; mostly-bold lines
 * qualify for heading2 from 1.05× (bold subheads are often barely larger than
 * body). Long lines (>120 chars) are demoted to paragraph — pull quotes and
 * large-print prose aren't headings.
 */
function classifyLine(line: Line, median: number): DocBlock['kind'] {
  if (BULLET_RE.test(line.text)) return 'bullet';
  if (median > 0 && line.text.length <= MAX_HEADING_CHARS) {
    const ratio = line.fontSize / median;
    if (ratio >= H1_RATIO) return 'heading1';
    if (ratio >= H2_RATIO) return 'heading2';
    if (ratio >= H2_BOLD_RATIO && line.bold) return 'heading2';
  }
  return 'paragraph';
}

// ——— paragraph stitching ———

/**
 * May `line` continue the block that `prevLine` ended?
 * - paragraph → paragraph: y-gap ≤ 1.6×fontSize, similar font size, and the
 *   previous line did NOT "end a sentence short of the right margin" (i.e. a
 *   line finishing with terminal punctuation while stopping before ~85% of
 *   the text width is a real paragraph end; a full-width line wraps on).
 * - bullet ← paragraph-shaped line: same rules, plus the continuation must be
 *   INDENTED past the bullet marker (wrapped list items align with their
 *   text) — that keeps the next flush-left paragraph out of the bullet.
 * - heading ← same-level heading line: small gap only (multi-line titles).
 * - everything else starts a new block.
 */
function canJoin(
  prevKind: DocBlock['kind'],
  kind: DocBlock['kind'],
  prevLine: Line,
  anchorX: number,
  line: Line,
  pageLeft: number,
  pageRight: number,
): boolean {
  const gap = prevLine.y - line.y; // positive when `line` is below
  if (gap <= 0 || gap > PARAGRAPH_GAP * prevLine.fontSize) return false;
  if (Math.abs(line.fontSize - prevLine.fontSize) > SIZE_TOLERANCE * prevLine.fontSize) return false;

  if ((prevKind === 'heading1' || prevKind === 'heading2') && kind === prevKind) return true;
  if (kind !== 'paragraph') return false;

  // "Ends a sentence short of the right margin" ⇒ paragraph is over.
  const endsSentence = /[.!?:;]["')\]]?$/.test(prevLine.text);
  const width = Math.max(1, pageRight - pageLeft);
  const fill = (prevLine.maxX - pageLeft) / width;
  if (endsSentence && fill < MARGIN_FILL) return false;

  if (prevKind === 'paragraph') return true;
  if (prevKind === 'bullet') {
    return line.minX >= anchorX + BULLET_INDENT * line.fontSize;
  }
  return false;
}

/**
 * Append a continuation line. Hyphenation repair: a line ending in "-" whose
 * continuation starts with a lowercase letter is a word split at the margin —
 * drop the hyphen and join directly ("recon-" + "struct" → "reconstruct").
 * Real compounds ("state-of-the-art") rarely break exactly at the hyphen with
 * a lowercase continuation AND deserve the join anyway.
 */
function joinText(prev: string, next: string): string {
  if (/[A-Za-z]-$/.test(prev) && /^[a-z]/.test(next)) return prev.slice(0, -1) + next;
  return `${prev} ${next}`;
}

// ——— small utils ———

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
