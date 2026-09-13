// ---------------------------------------------------------------------------
// Table detection for PDF→Excel — pure and DOM-free so the same code runs in
// the browser and the Node eval harness (scripts/pdf-eval.ts). Input is
// pdfjs-style text items reduced to {str, x, y, w, h} in PDF coordinates
// (y grows upward). Pipeline:
//   1. Group items into visual lines by y proximity (within 0.5× glyph height).
//   2. A RUN of ≥3 consecutive lines whose x-starts align into ≥2 shared
//      clusters (one missing/stray cell allowed per line) is a table candidate.
//   3. Column boundaries = x-start clusters that a majority of the run's lines
//      participate in; each item lands in its nearest column, multi-item cells
//      join left-to-right.
// Lines outside runs are prose and ignored by detectTables(); linesToRows()
// is the caller's fallback when a page has no tables, so the tool still
// outputs something useful (one single-cell row per visual line).
// Known limit: columns are matched by their LEFT edge, so fully right-aligned
// columns whose values vary a lot in width can fall below the tolerance.
// ---------------------------------------------------------------------------

export interface TextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DetectedTable {
  rows: string[][];
  /**
   * Vertical band the table occupies, in PDF points (y grows upward, so
   * `yTop` >= `yBottom`).
   *
   * PDF→Excel does not need this: each table becomes its own sheet and
   * whatever else is on the page is a separate sheet. PDF→Word does, because
   * there the table has to sit in reading order among the page's paragraphs —
   * which means the caller must be able to tell which text items the table
   * already consumed, or every cell would be emitted twice: once inside the
   * table and once again as loose paragraphs around it.
   */
  yTop: number;
  yBottom: number;
}

/** Assumed glyph height when an item reports none (rare pdfjs artifacts). */
const DEFAULT_H = 10;

const effH = (h: number): number => (h > 0 ? h : DEFAULT_H);

interface VisualLine {
  y: number; // anchor y of the first (topmost) item
  h: number; // tallest item seen on the line
  items: TextItem[]; // sorted left-to-right
}

/** Group items into visual lines: top-to-bottom, items left-to-right. */
function groupIntoLines(items: TextItem[]): VisualLine[] {
  const kept = items.filter((it) => it.str.trim() !== '');
  // y grows upward → descending y = top of page first; ties left-to-right.
  kept.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: VisualLine[] = [];
  for (const it of kept) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - it.y) <= 0.5 * Math.max(effH(line.h), effH(it.h))) {
      line.items.push(it);
      line.h = Math.max(line.h, effH(it.h));
    } else {
      lines.push({ y: it.y, h: effH(it.h), items: [it] });
    }
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

/** Join x-sorted items into text, inserting a space only across real x-gaps. */
function joinItems(items: TextItem[]): string {
  let out = '';
  let prev: TextItem | null = null;
  for (const it of items) {
    if (prev) {
      const gap = it.x - (prev.x + prev.w);
      const needSpace = gap > Math.max(1, 0.2 * Math.max(effH(prev.h), effH(it.h)));
      if (needSpace && !out.endsWith(' ') && !it.str.startsWith(' ')) out += ' ';
    }
    out += it.str;
    prev = it;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** x-alignment tolerance, scaled to the median glyph height (≈ font size). */
function xTolerance(lines: VisualLine[]): number {
  const hs = lines.flatMap((l) => l.items.map((it) => effH(it.h))).sort((a, b) => a - b);
  const median = hs.length > 0 ? hs[Math.floor(hs.length / 2)] : DEFAULT_H;
  return Math.max(4, 0.6 * median);
}

/** One-to-one nearest matching of two ascending x-start lists. */
function matchSorted(a: number[], b: number[], tol: number): { matched: number; unA: number; unB: number } {
  let i = 0;
  let j = 0;
  let matched = 0;
  while (i < a.length && j < b.length) {
    const d = a[i] - b[j];
    if (Math.abs(d) <= tol) {
      matched++;
      i++;
      j++;
    } else if (d < 0) i++;
    else j++;
  }
  return { matched, unA: a.length - matched, unB: b.length - matched };
}

/** Two lines share a column structure: ≥2 aligned starts, ≤1 stray per line. */
function columnCompatible(a: number[], b: number[], tol: number): boolean {
  const { matched, unA, unB } = matchSorted(a, b, tol);
  return matched >= 2 && unA <= 1 && unB <= 1;
}

/** Turn one run of column-compatible lines into a table (null → not a grid). */
function buildTable(lines: VisualLine[], tol: number): DetectedTable | null {
  // Cluster every x-start across the run (ascending, chained by gap ≤ tol).
  const entries = lines
    .flatMap((line, li) => line.items.map((it) => ({ x: it.x, line: li })))
    .sort((a, b) => a.x - b.x);
  const clusters: { xs: number[]; lines: Set<number> }[] = [];
  for (const e of entries) {
    const c = clusters[clusters.length - 1];
    if (c && e.x - c.xs[c.xs.length - 1] <= tol) {
      c.xs.push(e.x);
      c.lines.add(e.line);
    } else {
      clusters.push({ xs: [e.x], lines: new Set([e.line]) });
    }
  }

  // Real columns are clusters that most lines take part in — a stray item
  // (wrapped cell, footnote mark) forms a 1-line cluster and is filtered
  // here, then absorbed into its nearest surviving column below.
  const minLines = Math.max(2, Math.ceil(lines.length / 2));
  const centers = clusters
    .filter((c) => c.lines.size >= minLines)
    .map((c) => c.xs.reduce((sum, x) => sum + x, 0) / c.xs.length);
  if (centers.length < 2) return null;

  const rows = lines.map((line) => {
    const cells: TextItem[][] = centers.map(() => []);
    for (const it of line.items) {
      let best = 0;
      for (let c = 1; c < centers.length; c++) {
        if (Math.abs(centers[c] - it.x) < Math.abs(centers[best] - it.x)) best = c;
      }
      cells[best].push(it); // stays x-sorted — line.items already is
    }
    return cells.map(joinItems);
  });
  // `lines` is top-to-bottom, and y grows upward, so the first line carries
  // the largest y. Pad by each end line's own height so the band covers the
  // full glyph box rather than just the baseline anchors.
  const first = lines[0];
  const last = lines[lines.length - 1];
  return {
    rows,
    yTop: first.y + effH(first.h),
    yBottom: last.y - effH(last.h),
  };
}

/**
 * Detect grid-aligned tables among a page's text items, in reading order.
 * Lines that are not part of any run (prose) are ignored.
 */
export function detectTables(items: TextItem[]): DetectedTable[] {
  const lines = groupIntoLines(items);
  if (lines.length < 3) return [];
  const tol = xTolerance(lines);
  const sigs = lines.map((l) => l.items.map((it) => it.x)); // ascending

  const tables: DetectedTable[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    while (end + 1 < lines.length && columnCompatible(sigs[end], sigs[end + 1], tol)) end++;
    if (end - start + 1 >= 3) {
      const table = buildTable(lines.slice(start, end + 1), tol);
      if (table) tables.push(table);
    }
    start = end + 1;
  }
  return tables;
}

/**
 * Fallback when no table is detected: every visual line becomes one
 * single-cell row, so PDF→Excel still emits the page's text usefully.
 */
export function linesToRows(items: TextItem[]): string[][] {
  return groupIntoLines(items)
    .map((line) => joinItems(line.items))
    .filter((text) => text !== '')
    .map((text) => [text]);
}
