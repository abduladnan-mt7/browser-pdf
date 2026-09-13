// Document block model for the doc→PDF converters (html/markdown/text → PDF),
// plus the two pure input parsers. Mirrors reconstruct.ts's philosophy: no DOM,
// no pdf-lib, so everything here runs identically in the browser and in the
// Node eval harness (scripts/pdf-eval.ts). The browser-only HTML parser lives
// in htmlBlocks.ts; the typesetter that consumes DocBlock[] lives in
// ops/typeset.ts.

export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Inline code span → mono font. */
  code?: boolean;
  /** Link target → colored + underlined + a real Link annotation. */
  href?: string;
  /** Text color as #rrggbb — from computed styles (html path only). */
  color?: string;
}

/** Optional per-block presentation, extracted from computed CSS by the html
 *  path. Absent (markdown/text paths) → the typesetter's defaults apply, so
 *  those pipelines are byte-identical to before this type existed. */
export interface BlockStyle {
  align?: 'left' | 'center' | 'right';
  /** Body font size for the block, points. */
  sizePt?: number;
  /** Default text color as #rrggbb. */
  color?: string;
  /** Vertical spacing overrides, points. */
  spaceBefore?: number;
  spaceAfter?: number;
  /** Draw a rule under the block (heading border-bottom). */
  rule?: boolean;
  /** Line height as a ratio of font size (e.g. 1.21). */
  lineHeight?: number;
}

export type DocBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; runs: InlineRun[]; style?: BlockStyle }
  | { kind: 'paragraph'; runs: InlineRun[]; style?: BlockStyle }
  | { kind: 'listItem'; ordered: boolean; index: number; depth: number; runs: InlineRun[]; style?: BlockStyle }
  | { kind: 'blockquote'; runs: InlineRun[]; style?: BlockStyle }
  // A flex space-between line: left content + right content on one baseline
  // (the resume "role ⟷ date" pattern).
  | { kind: 'splitRow'; left: InlineRun[]; right: InlineRun[]; style?: BlockStyle }
  | { kind: 'code'; text: string; lang?: string }
  // Plain-text cells (markdown path). The html path may add styled-run cells
  // in headerRuns/rowRuns (same shape, takes precedence), plus layout hints.
  | {
      kind: 'table';
      header: string[];
      rows: string[][];
      headerRuns?: InlineRun[][];
      rowRuns?: InlineRun[][][];
      /** Column width hints (any unit — normalized proportionally). */
      colWidths?: number[];
      /** True → no grid lines, no header background. */
      borderless?: boolean;
      style?: BlockStyle;
    }
  | { kind: 'image'; bytes: Uint8Array; format: 'png' | 'jpg'; caption?: string }
  | { kind: 'hr' };

/** Merge adjacent runs whose style flags match — keeps the typesetter's
 *  measure/draw loop from fragmenting on every word of styled text. */
export function mergeRuns(runs: InlineRun[]): InlineRun[] {
  const out: InlineRun[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const prev = out[out.length - 1];
    if (prev && !!prev.bold === !!r.bold && !!prev.italic === !!r.italic &&
        !!prev.code === !!r.code && prev.href === r.href && prev.color === r.color) {
      prev.text += r.text;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** Plain text → paragraphs. Blank line(s) separate paragraphs; a single
 *  newline inside a paragraph is a soft wrap (joined with a space). */
// ——— plain text ————————————————————————————————————————————————————————
//
// Plain text is not shapeless. People write headings in CAPS or underline them
// with ===, start lists with "-" or "1.", quote with ">", and indent code. The
// typesetter renders every one of those, so the only reason text→PDF used to
// come out as an undifferentiated wall of 11pt body copy was that this parser
// threw the structure away before the typesetter ever saw it: it joined every
// line in a block with a space (turning a bullet list into "- a - b - c") and
// collapsed all indentation.
//
// This is NOT a markdown parser — markdownToBlocks below is, and it runs the
// real lexer. The rules here are deliberately limited to conventions people
// use in genuinely plain text, and each one is conservative, because the
// failure modes are asymmetric: missing a heading costs a little emphasis,
// while inventing one out of an ordinary sentence makes the output look broken.

/** `---`, `***`, `___` alone on a line. Not `===`, which is a setext underline. */
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const SETEXT_H1_RE = /^\s*={3,}\s*$/;
const SETEXT_H2_RE = /^\s*-{3,}\s*$/;
const BULLET_RE = /^(\s*)[-*+•·‣]\s+(.*)$/;
const ORDERED_RE = /^(\s*)(?:\((\d{1,3})\)|(\d{1,3})[.)])\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const INDENTED_RE = /^(?: {4,}|\t)(.*)$/;

/** A short line in CAPS reads as a heading — "SHIPPING ADDRESS", "PART TWO". */
function isCapsHeading(line: string): boolean {
  const t = line.trim();
  if (t.length < 2 || t.length > 80) return false;
  if (/[.!?]$/.test(t)) return false;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length < 2) return false;
  return letters === letters.toUpperCase();
}

/** "Ingredients:", "Next steps:" — a short labelled line introducing a block. */
function isLabelHeading(line: string): boolean {
  const t = line.trim();
  return (
    t.endsWith(':') &&
    t.length <= 60 &&
    t.split(/\s+/).length <= 8 &&
    (t.match(/:/g) ?? []).length === 1
  );
}

function runsOf(text: string): InlineRun[] {
  return [{ text }];
}

/**
 * Convert plain text to blocks, recovering the structure the author typed.
 *
 * Hard-wrapped prose still joins into one paragraph — that is the common case
 * and the reason the old implementation joined lines at all. The difference is
 * that joining now happens only within a run of lines that are actually prose,
 * instead of across list items and headings too.
 */
export function textToBlocks(text: string): DocBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  // A document typed entirely in capitals (some invoices, some legal notices)
  // would otherwise become nothing but headings. CAPS only signals a heading
  // when it stands out from the surrounding text, so measure how much of the
  // document is shouting: past a clear majority it is the house style, not
  // emphasis, and the signal is worthless.
  //
  // The threshold has to sit above 0.5, because the most ordinary case there
  // is — one CAPS heading over one line of body — is already a 50% share.
  const nonBlank = lines.filter((l) => l.trim());
  const capsShare = nonBlank.length
    ? nonBlank.filter(isCapsHeading).length / nonBlank.length
    : 0;
  const capsMeansHeading = capsShare <= 0.6;

  const out: DocBlock[] = [];
  /** Prose lines waiting to be joined into one paragraph. */
  let para: string[] = [];
  /** Indent widths seen in the current list, so nesting maps to depth 0,1,2,3. */
  let listIndents: number[] = [];
  let orderedCounter = 0;

  const flushPara = () => {
    if (!para.length) return;
    const joined = para.join(' ').replace(/\s+/g, ' ').trim();
    if (joined) out.push({ kind: 'paragraph', runs: runsOf(joined) });
    para = [];
  };
  /** Any block boundary ends both the paragraph and the current list nesting. */
  const flushAll = () => {
    flushPara();
    listIndents = [];
    orderedCounter = 0;
  };

  /** Map a list marker's indent onto a 0-3 depth via the widths seen so far. */
  const depthFor = (indent: number): number => {
    let i = listIndents.findIndex((w) => w === indent);
    if (i === -1) {
      // Deeper than anything seen → one level in. Shallower → unwind to it.
      while (listIndents.length && listIndents[listIndents.length - 1] > indent) {
        listIndents.pop();
      }
      if (!listIndents.length || listIndents[listIndents.length - 1] < indent) {
        listIndents.push(indent);
      }
      i = listIndents.length - 1;
    }
    return Math.min(i, 3);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? '';

    if (!line.trim()) { flushAll(); continue; }

    // Setext headings consume their underline, so they are checked before the
    // horizontal rule — otherwise "Title\n-----" would emit a paragraph + rule.
    if (line.trim() && SETEXT_H1_RE.test(next)) {
      flushAll();
      out.push({ kind: 'heading', level: 1, runs: runsOf(line.trim()) });
      i++;
      continue;
    }
    if (line.trim() && !HR_RE.test(line) && SETEXT_H2_RE.test(next)) {
      flushAll();
      out.push({ kind: 'heading', level: 2, runs: runsOf(line.trim()) });
      i++;
      continue;
    }

    if (HR_RE.test(line)) { flushAll(); out.push({ kind: 'hr' }); continue; }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      flushAll();
      // Consecutive "> " lines are one quotation, not one per line.
      const parts = [quote[1]];
      while (QUOTE_RE.test(lines[i + 1] ?? '')) {
        parts.push(QUOTE_RE.exec(lines[++i])![1]);
      }
      const body = parts.join(' ').replace(/\s+/g, ' ').trim();
      if (body) out.push({ kind: 'blockquote', runs: runsOf(body) });
      continue;
    }

    // List markers are checked before indented-code so that a nested "  - item"
    // stays a list item rather than becoming a code block.
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      flushPara();
      out.push({
        kind: 'listItem',
        ordered: false,
        index: 0,
        depth: depthFor(bullet[1].length),
        runs: runsOf(bullet[2].trim()),
      });
      continue;
    }

    const ordered = ORDERED_RE.exec(line);
    if (ordered) {
      flushPara();
      const num = Number(ordered[2] ?? ordered[3]);
      orderedCounter = Number.isFinite(num) ? num : orderedCounter + 1;
      out.push({
        kind: 'listItem',
        ordered: true,
        index: orderedCounter,
        depth: depthFor(ordered[1].length),
        runs: runsOf(ordered[4].trim()),
      });
      continue;
    }

    // Indented block → code. Only when a paragraph is not already open, so a
    // hand-wrapped sentence with a stray indent stays part of its paragraph.
    const indented = INDENTED_RE.exec(line);
    if (indented && !para.length) {
      flushAll();
      const body = [indented[1]];
      while (INDENTED_RE.test(lines[i + 1] ?? '') || (lines[i + 1] ?? '').trim() === '') {
        const peek = lines[i + 1] ?? '';
        if (!peek.trim()) {
          // A blank line only continues the block if more indented text follows.
          if (!INDENTED_RE.test(lines[i + 2] ?? '')) break;
          body.push('');
          i++;
          continue;
        }
        body.push(INDENTED_RE.exec(lines[++i])![1]);
      }
      const code = body.join('\n').replace(/\s+$/, '');
      if (code.trim()) out.push({ kind: 'code', text: code });
      continue;
    }

    if (capsMeansHeading && isCapsHeading(line)) {
      flushAll();
      out.push({ kind: 'heading', level: 2, runs: runsOf(line.trim()) });
      continue;
    }

    if (isLabelHeading(line) && !para.length) {
      flushAll();
      out.push({ kind: 'heading', level: 3, runs: runsOf(line.trim()) });
      continue;
    }

    para.push(line.trim());
  }

  flushAll();
  return out;
}

// ——— markdown ———————————————————————————————————————————————————————————
// marked.lexer token walking. `marked` loads on demand so the client bundle
// only pays for it on the markdown tool (same pattern as MarkdownConverter).

interface MdToken {
  type: string;
  raw?: string;
  text?: string;
  depth?: number;
  lang?: string;
  href?: string;
  ordered?: boolean;
  start?: number | '';
  tokens?: MdToken[];
  items?: MdToken[];
  header?: { text: string; tokens?: MdToken[] }[];
  rows?: { text: string; tokens?: MdToken[] }[][];
}

interface InlineStyle { bold?: boolean; italic?: boolean; code?: boolean; href?: string }

function inlineRuns(tokens: MdToken[] | undefined, style: InlineStyle = {}): InlineRun[] {
  const out: InlineRun[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong': out.push(...inlineRuns(t.tokens, { ...style, bold: true })); break;
      case 'em': out.push(...inlineRuns(t.tokens, { ...style, italic: true })); break;
      case 'codespan': out.push({ ...style, code: true, text: t.text ?? '' }); break;
      case 'link': out.push(...inlineRuns(t.tokens, { ...style, href: t.href })); break;
      case 'del': out.push(...inlineRuns(t.tokens, style)); break;
      case 'br': out.push({ ...style, text: ' ' }); break;
      case 'escape': out.push({ ...style, text: t.text ?? '' }); break;
      case 'image': out.push({ ...style, italic: true, text: t.text ? `[${t.text}]` : '' }); break;
      case 'text':
        if (t.tokens?.length) out.push(...inlineRuns(t.tokens, style));
        else out.push({ ...style, text: unescapeMd(t.text ?? '') });
        break;
      default: if (t.text) out.push({ ...style, text: unescapeMd(t.text) });
    }
  }
  return mergeRuns(out);
}

/** marked's lexer HTML-escapes text content (&amp; etc.) — undo for PDF text. */
function unescapeMd(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function inlinePlainText(tokens: MdToken[] | undefined): string {
  return inlineRuns(tokens).map((r) => r.text).join('').trim();
}

function walkBlocks(tokens: MdToken[], out: DocBlock[], listDepth: number): void {
  for (const t of tokens) {
    switch (t.type) {
      case 'heading': {
        const level = Math.min(Math.max(t.depth ?? 1, 1), 3) as 1 | 2 | 3;
        out.push({ kind: 'heading', level, runs: inlineRuns(t.tokens) });
        break;
      }
      case 'paragraph':
        out.push({ kind: 'paragraph', runs: inlineRuns(t.tokens) });
        break;
      case 'list': {
        const startAt = typeof t.start === 'number' ? t.start : 1;
        (t.items ?? []).forEach((item, i) => {
          // An item's tokens are inline-ish ('text' wrappers) plus any nested lists.
          const inline: MdToken[] = [];
          const nested: MdToken[] = [];
          for (const it of item.tokens ?? []) {
            if (it.type === 'list') nested.push(it);
            else inline.push(...(it.tokens ?? (it.text ? [it] : [])));
          }
          out.push({
            kind: 'listItem',
            ordered: !!t.ordered,
            index: startAt + i,
            depth: listDepth,
            runs: inlineRuns(inline),
          });
          if (nested.length) walkBlocks(nested, out, listDepth + 1);
        });
        break;
      }
      case 'blockquote': {
        // Flatten the quote's inner blocks into one run stream.
        const inner: DocBlock[] = [];
        walkBlocks(t.tokens ?? [], inner, listDepth);
        const runs: InlineRun[] = [];
        for (const b of inner) {
          if ('runs' in b && b.runs.length) {
            if (runs.length) runs.push({ text: ' ' });
            runs.push(...b.runs);
          }
        }
        out.push({ kind: 'blockquote', runs: mergeRuns(runs) });
        break;
      }
      case 'code':
        out.push({ kind: 'code', text: t.text ?? '', lang: t.lang || undefined });
        break;
      case 'table':
        out.push({
          kind: 'table',
          header: (t.header ?? []).map((c) => inlinePlainText(c.tokens) || c.text || ''),
          rows: (t.rows ?? []).map((row) => row.map((c) => inlinePlainText(c.tokens) || c.text || '')),
        });
        break;
      case 'hr':
        out.push({ kind: 'hr' });
        break;
      case 'space':
        break;
      case 'html': {
        // Raw HTML inside markdown: cheap tag-strip to text (disclosed in UI).
        const stripped = (t.text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (stripped) out.push({ kind: 'paragraph', runs: [{ text: unescapeMd(stripped) }] });
        break;
      }
      default:
        if (t.text) out.push({ kind: 'paragraph', runs: [{ text: unescapeMd(t.text) }] });
    }
  }
}

/** Markdown → blocks via marked's lexer. Pure token walking — Node-testable. */
export async function markdownToBlocks(md: string): Promise<DocBlock[]> {
  const { marked } = await import('marked');
  const tokens = marked.lexer(md) as unknown as MdToken[];
  const out: DocBlock[] = [];
  walkBlocks(tokens, out, 0);
  return out;
}
