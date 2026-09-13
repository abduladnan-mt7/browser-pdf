// Page-range parsing shared by every PDF tool ("2, 4-6, 11" → [2,4,5,6,11]).
// Replaces the near-identical parsers previously copy-pasted across the
// standalone tools. 1-based in, 1-based out; callers subtract 1 for indices.

/**
 * Parse a human page-range string against a document with `pageCount` pages.
 * Accepts "3", "2-5", "7-" (to end), "-4" (from start), comma/space separated.
 * Returns sorted, de-duplicated 1-based page numbers.
 * Throws Error with a user-facing message on invalid input.
 */
export function parsePageRanges(input: string, pageCount: number): number[] {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Enter at least one page or range, like "1-3, 5".');

  const picked = new Set<number>();
  for (const part of trimmed.split(/[,;]+/)) {
    const token = part.trim();
    if (!token) continue;

    const m = token.match(/^(\d+)?\s*-\s*(\d+)?$/) ?? token.match(/^(\d+)$/);
    if (!m) throw new Error(`"${token}" isn't a page or range — use numbers like "3" or "2-5".`);

    const isRange = token.includes('-');
    const start = m[1] ? parseInt(m[1], 10) : 1;
    const end = isRange ? (m[2] ? parseInt(m[2], 10) : pageCount) : start;

    if (start < 1 || end < 1) throw new Error('Page numbers start at 1.');
    if (start > pageCount || end > pageCount) {
      throw new Error(`This PDF only has ${pageCount} ${pageCount === 1 ? 'page' : 'pages'} — "${token}" is out of range.`);
    }
    if (start > end) throw new Error(`"${token}" is backwards — put the smaller page first.`);

    for (let p = start; p <= end; p++) picked.add(p);
  }

  if (picked.size === 0) throw new Error('Enter at least one page or range, like "1-3, 5".');
  return Array.from(picked).sort((a, b) => a - b);
}

/** Non-throwing variant for live validation — returns null on bad input. */
export function tryParsePageRanges(input: string, pageCount: number): number[] | null {
  try {
    return parsePageRanges(input, pageCount);
  } catch {
    return null;
  }
}
