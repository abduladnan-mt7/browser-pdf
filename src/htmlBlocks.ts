// HTML → DocBlock[] for the html-to-pdf converter. Browser-only (DOM, fetch,
// canvas) — the glue layer in front of the typesetter (ops/typeset.ts).
//
// The input is rendered in a hidden same-origin iframe so every element gets
// REAL computed styles: font weights/sizes/colors set via CSS classes, text
// alignment, margins, heading border-bottom rules, flex space-between rows
// (the resume "role ⟷ date" pattern → splitRow blocks), borderless tables
// with measured column widths. This is still a reading-order reconstruction —
// grids/floats/columns flatten — but a *styled* one.
//
// If the iframe path fails for any reason, the same walker runs over a bare
// DOMParser document (no computed styles) and degrades to tag-only parsing.
//
// Images: data:-URI and same-origin sources are embedded; PNG/JPEG bytes pass
// through untouched, anything else the browser can decode (webp/gif/avif) is
// re-encoded to PNG via canvas. Cross-origin images are skipped and counted —
// no proxy, nothing leaves the device.

import { mergeRuns, type BlockStyle, type DocBlock, type InlineRun } from './docmodel';

export interface HtmlParseResult {
  blocks: DocBlock[];
  /** External images we refused to fetch (cross-origin) or couldn't decode. */
  skippedImages: number;
  /** Page margin suggestion from the source body's padding, points. */
  marginPt?: number;
}

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'SVG', 'HEAD',
  'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'CANVAS', 'VIDEO', 'AUDIO',
]);
const CONTAINER_TAGS = new Set([
  'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'NAV',
  'BODY', 'FORM', 'DETAILS', 'SUMMARY', 'FIGURE',
]);
const INLINE_TAGS = new Set([
  'STRONG', 'B', 'EM', 'I', 'CODE', 'KBD', 'SAMP', 'A', 'BR', 'SPAN', 'SMALL',
  'SUB', 'SUP', 'MARK', 'U', 'S', 'ABBR', 'TIME', 'IMG',
]);

const PX_TO_PT = 0.75;

interface Ctx {
  blocks: DocBlock[];
  skippedImages: number;
  /** Computed-style accessor; null in the DOMParser fallback. */
  css: ((el: Element) => CSSStyleDeclaration) | null;
}

interface InlineStyle { bold?: boolean; italic?: boolean; code?: boolean; href?: string; color?: string; upper?: boolean }

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ');
}

/** 'rgb(15, 76, 129)' → '#0f4c81'. Returns undefined for transparent/odd values. */
function cssColorToHex(c: string | undefined): string | undefined {
  if (!c) return undefined;
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(c);
  if (!m) return undefined;
  if (m[4] !== undefined && parseFloat(m[4]) < 0.5) return undefined;
  const hex = (n: string) => Number(n).toString(16).padStart(2, '0');
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Extract the typeset-relevant computed styles of a block element. */
function blockStyleOf(ctx: Ctx, el: Element): BlockStyle | undefined {
  if (!ctx.css) return undefined;
  const cs = ctx.css(el);
  const style: BlockStyle = {};

  const ta = cs.textAlign;
  if (ta === 'center') style.align = 'center';
  else if (ta === 'right' || ta === 'end') style.align = 'right';

  const px = parseFloat(cs.fontSize);
  if (px > 0) style.sizePt = round2(Math.min(36, Math.max(6, px * PX_TO_PT)));

  const color = cssColorToHex(cs.color);
  if (color && color !== '#000000') style.color = color;

  const mt = parseFloat(cs.marginTop);
  if (mt > 0) style.spaceBefore = round2(Math.min(24, mt * PX_TO_PT));
  const mb = parseFloat(cs.marginBottom);
  if (mb >= 0) style.spaceAfter = round2(Math.min(24, mb * PX_TO_PT));

  if (parseFloat(cs.borderBottomWidth) > 0 && cs.borderBottomStyle !== 'none') style.rule = true;

  const lh = parseFloat(cs.lineHeight);
  if (lh > 0 && px > 0) style.lineHeight = round2(Math.min(2.2, Math.max(1, lh / px)));

  return style;
}

function inlineStyleOf(ctx: Ctx, el: Element, base: InlineStyle): InlineStyle {
  const next = { ...base };
  switch (el.tagName) {
    case 'STRONG': case 'B': next.bold = true; break;
    case 'EM': case 'I': next.italic = true; break;
    case 'CODE': case 'KBD': case 'SAMP': next.code = true; break;
    case 'U': break;
  }
  if (el.tagName === 'A') {
    const href = el.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) next.href = href;
  }
  if (ctx.css) {
    const cs = ctx.css(el);
    const weight = parseInt(cs.fontWeight, 10);
    if (weight >= 600) next.bold = true;
    if (cs.fontStyle === 'italic' || cs.fontStyle === 'oblique') next.italic = true;
    if (/mono|courier|consolas/i.test(cs.fontFamily)) next.code = true;
    const color = cssColorToHex(cs.color);
    if (color) next.color = color;
    next.upper = cs.textTransform === 'uppercase';
  }
  return next;
}

/** Inline-phase walk: flatten an element's inline content into styled runs. */
function inlineRunsOf(ctx: Ctx, node: Node, style: InlineStyle): InlineRun[] {
  const out: InlineRun[] = [];
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      let text = collapseWs(child.textContent ?? '');
      if (style.upper) text = text.toUpperCase();
      if (text) {
        out.push({
          text,
          bold: style.bold, italic: style.italic, code: style.code,
          href: style.href, color: style.color,
        });
      }
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const el = child as Element;
    // Nested lists inside an <li> are block content — the walker recurses
    // into them separately; they never belong to the item's own runs.
    if (el.tagName === 'UL' || el.tagName === 'OL') return;
    if (SKIP_TAGS.has(el.tagName) || (el as HTMLElement).hidden) return;
    if (ctx.css) {
      const cs = ctx.css(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
    }
    if (el.tagName === 'BR') {
      out.push({ text: ' ' });
      return;
    }
    out.push(...inlineRunsOf(ctx, el, inlineStyleOf(ctx, el, style)));
  });
  return out;
}

function baseInline(ctx: Ctx, el: Element): InlineStyle {
  if (!ctx.css) return {};
  const cs = ctx.css(el);
  return {
    bold: parseInt(cs.fontWeight, 10) >= 600 || undefined,
    italic: cs.fontStyle === 'italic' || undefined,
    color: cssColorToHex(cs.color),
    upper: cs.textTransform === 'uppercase' || undefined,
  };
}

function elementRuns(ctx: Ctx, el: Element): InlineRun[] {
  return mergeRuns(inlineRunsOf(ctx, el, baseInline(ctx, el)));
}

function trimRuns(runs: InlineRun[]): InlineRun[] {
  if (runs.length) {
    runs[0].text = runs[0].text.replace(/^\s+/, '');
    runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, '');
  }
  return runs.filter((r) => r.text);
}

function pushRuns(ctx: Ctx, kind: 'paragraph' | 'blockquote', el: Element): void {
  const runs = trimRuns(elementRuns(ctx, el));
  if (runs.some((r) => r.text.trim())) {
    ctx.blocks.push({ kind, runs, style: blockStyleOf(ctx, el) });
  }
}

/** True when the element has no block-level children (pure inline content). */
function isInlineOnly(el: Element): boolean {
  for (const child of Array.from(el.children)) {
    if (SKIP_TAGS.has(child.tagName)) continue;
    if (!INLINE_TAGS.has(child.tagName)) return false;
  }
  return true;
}

/** display:flex + justify-content:space-between + inline children →
 *  the "left ⟷ right" line (resume role/date rows). */
function asSplitRow(ctx: Ctx, el: Element): DocBlock | null {
  if (!ctx.css) return null;
  const cs = ctx.css(el);
  if (!/flex/.test(cs.display) || cs.justifyContent !== 'space-between') return null;
  const kids = Array.from(el.children).filter((k) => !SKIP_TAGS.has(k.tagName));
  if (kids.length < 2 || !kids.every((k) => isInlineOnly(k) || INLINE_TAGS.has(k.tagName))) return null;
  const left: InlineRun[] = [];
  for (const k of kids.slice(0, -1)) {
    if (left.length) left.push({ text: ' ' });
    left.push(...elementRuns(ctx, k));
  }
  const right = elementRuns(ctx, kids[kids.length - 1]);
  if (!left.some((r) => r.text.trim()) && !right.some((r) => r.text.trim())) return null;
  return {
    kind: 'splitRow',
    left: trimRuns(mergeRuns(left)),
    right: trimRuns(mergeRuns(right)),
    style: blockStyleOf(ctx, el),
  };
}

async function imageBlock(ctx: Ctx, el: Element, caption?: string): Promise<void> {
  const src = el.getAttribute('src') ?? '';
  if (!src) return;
  let url: URL;
  try {
    url = new URL(src, window.location.href);
  } catch {
    ctx.skippedImages++;
    return;
  }
  const sameOrigin = url.protocol === 'data:' || url.origin === window.location.origin;
  if (!sameOrigin) {
    ctx.skippedImages++;
    return;
  }
  try {
    const res = await fetch(url.href);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const isPng = bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const isJpg = bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
    if (isPng || isJpg) {
      ctx.blocks.push({ kind: 'image', bytes, format: isPng ? 'png' : 'jpg', caption });
      return;
    }
    // Other formats (webp/gif/avif): let the browser decode, re-encode as PNG.
    const png = await recodeToPng(url.href);
    if (png) ctx.blocks.push({ kind: 'image', bytes: png, format: 'png', caption });
    else ctx.skippedImages++;
  } catch {
    ctx.skippedImages++;
  }
}

function recodeToPng(src: string): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d')!.drawImage(img, 0, 0);
        canvas.toBlob(async (blob) => {
          resolve(blob ? new Uint8Array(await blob.arrayBuffer()) : null);
        }, 'image/png');
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function tableBlock(ctx: Ctx, el: Element): void {
  const textOf = (cell: Element) => collapseWs(cell.textContent ?? '').trim();
  const allRows = Array.from(el.querySelectorAll(':scope > thead > tr, :scope > tbody > tr, :scope > tr'));
  if (!allRows.length) return;
  let headerEls: Element[] = [];
  let bodyRowEls = allRows;
  const theadRow = el.querySelector(':scope > thead > tr');
  if (theadRow) {
    headerEls = Array.from(theadRow.querySelectorAll('th,td'));
    bodyRowEls = allRows.filter((r) => r !== theadRow);
  } else if (allRows[0]?.querySelector('th')) {
    headerEls = Array.from(allRows[0].querySelectorAll('th,td'));
    bodyRowEls = allRows.slice(1);
  }
  const bodyCellEls = bodyRowEls
    .map((r) => Array.from(r.querySelectorAll('th,td')))
    .filter((cells) => cells.some((c) => textOf(c)));
  if (!headerEls.some(textOf) && !bodyCellEls.length) return;

  const block: Extract<DocBlock, { kind: 'table' }> = {
    kind: 'table',
    header: headerEls.map(textOf),
    rows: bodyCellEls.map((cells) => cells.map(textOf)),
    style: blockStyleOf(ctx, el),
  };

  if (ctx.css) {
    // Styled cells (bold key columns survive), borderless detection, and
    // real column widths measured from the rendered layout.
    block.headerRuns = headerEls.map((c) => trimRuns(elementRuns(ctx, c)));
    block.rowRuns = bodyCellEls.map((cells) => cells.map((c) => trimRuns(elementRuns(ctx, c))));
    const sampleCells = bodyCellEls[0] ?? headerEls;
    block.borderless = sampleCells.every((c) => {
      const cs = ctx.css!(c);
      return parseFloat(cs.borderTopWidth) === 0 && parseFloat(cs.borderLeftWidth) === 0 &&
        parseFloat(cs.borderBottomWidth) === 0 && parseFloat(cs.borderRightWidth) === 0;
    });
    const widths = sampleCells.map((c) => c.getBoundingClientRect().width);
    if (widths.every((w) => w > 0)) block.colWidths = widths.map(round2);
  }
  ctx.blocks.push(block);
}

async function walk(ctx: Ctx, el: Element, listDepth: number): Promise<void> {
  if (SKIP_TAGS.has(el.tagName) || (el as HTMLElement).hidden) return;
  if (ctx.css) {
    const cs = ctx.css(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
  }

  switch (el.tagName) {
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
      const level = Math.min(Number(el.tagName[1]), 3) as 1 | 2 | 3;
      const runs = trimRuns(elementRuns(ctx, el));
      if (runs.some((r) => r.text.trim())) {
        ctx.blocks.push({ kind: 'heading', level, runs, style: blockStyleOf(ctx, el) });
      }
      return;
    }
    case 'P':
      pushRuns(ctx, 'paragraph', el);
      return;
    case 'BLOCKQUOTE':
      pushRuns(ctx, 'blockquote', el);
      return;
    case 'PRE': {
      const code = el.querySelector('code');
      const lang = /language-(\w+)/.exec(code?.className ?? '')?.[1];
      const text = (el.textContent ?? '').replace(/^\n+|\n+$/g, '');
      if (text.trim()) ctx.blocks.push({ kind: 'code', text, lang });
      return;
    }
    case 'UL': case 'OL': {
      const ordered = el.tagName === 'OL';
      const start = Number(el.getAttribute('start') ?? '1') || 1;
      let i = 0;
      for (const li of Array.from(el.children)) {
        if (li.tagName !== 'LI') continue;
        // The item's inline content becomes the run (inlineRunsOf skips
        // nested lists); nested lists recurse with depth + 1 below.
        const runs = trimRuns(elementRuns(ctx, li));
        if (runs.some((r) => r.text.trim())) {
          ctx.blocks.push({ kind: 'listItem', ordered, index: start + i, depth: listDepth, runs, style: blockStyleOf(ctx, li) });
        }
        i++;
        for (const nested of Array.from(li.children)) {
          if (nested.tagName === 'UL' || nested.tagName === 'OL') await walk(ctx, nested, listDepth + 1);
        }
      }
      return;
    }
    case 'TABLE':
      tableBlock(ctx, el);
      return;
    case 'HR':
      ctx.blocks.push({ kind: 'hr' });
      return;
    case 'IMG':
      await imageBlock(ctx, el);
      return;
    case 'FIGURE': {
      const img = el.querySelector(':scope > img');
      const caption = collapseWs(el.querySelector(':scope > figcaption')?.textContent ?? '').trim();
      if (img) {
        await imageBlock(ctx, img, caption || undefined);
        return;
      }
      break; // figure without an image: fall through to container handling
    }
  }

  if (CONTAINER_TAGS.has(el.tagName) || el.tagName === 'FIGURE') {
    const split = asSplitRow(ctx, el);
    if (split) {
      ctx.blocks.push(split);
      return;
    }
    if (el.tagName !== 'BODY' && isInlineOnly(el)) {
      // A div/section holding only inline content reads as a paragraph…
      pushRuns(ctx, 'paragraph', el);
      // …but any inline <img> inside it still deserves embedding.
      for (const img of Array.from(el.querySelectorAll(':scope img'))) await imageBlock(ctx, img);
      return;
    }
    for (const child of Array.from(el.children)) await walk(ctx, child, listDepth);
    // Loose text directly inside the container (rare, but legal HTML).
    const loose = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join(' ');
    if (loose.trim()) {
      ctx.blocks.push({ kind: 'paragraph', runs: [{ text: collapseWs(loose).trim() }], style: blockStyleOf(ctx, el) });
    }
    return;
  }

  // Unknown block-ish element: treat its inline content as a paragraph.
  pushRuns(ctx, 'paragraph', el);
}

/** Render the HTML in a hidden iframe and resolve its body + window. */
function renderInIframe(html: string): Promise<{ body: Element; win: Window; dispose: () => void }> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-same-origin'); // no scripts, ever
    // A4 width at CSS 96dpi so flex/table layout matches the print target.
    iframe.style.cssText = 'position:fixed;left:-11000px;top:0;width:794px;height:1123px;visibility:hidden;';
    const timer = setTimeout(() => {
      iframe.remove();
      reject(new Error('iframe render timeout'));
    }, 5000);
    iframe.onload = () => {
      // No rAF here: rAF never fires in a backgrounded tab (it would silently
      // time out into the styleless fallback). getComputedStyle /
      // getBoundingClientRect force synchronous layout anyway.
      clearTimeout(timer);
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!doc?.body || !win) {
        iframe.remove();
        reject(new Error('iframe document unavailable'));
        return;
      }
      resolve({ body: doc.body, win: win as unknown as Window, dispose: () => iframe.remove() });
    };
    // srcdoc BEFORE append: appending a src-less iframe fires a load event
    // for about:blank, which would resolve with an empty body.
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  });
}

/** Parse an HTML document/fragment into typesettable blocks. Browser-only. */
export async function htmlToBlocks(html: string): Promise<HtmlParseResult> {
  // Preferred path: real layout + computed styles.
  try {
    const { body, win, dispose } = await renderInIframe(html);
    try {
      const ctx: Ctx = { blocks: [], skippedImages: 0, css: (el) => win.getComputedStyle(el) };
      await walk(ctx, body, 0);
      const pad = parseFloat(win.getComputedStyle(body).paddingLeft) * PX_TO_PT;
      const marginPt = pad >= 15 && pad <= 80 ? round2(pad) : undefined;
      return { blocks: ctx.blocks, skippedImages: ctx.skippedImages, marginPt };
    } finally {
      dispose();
    }
  } catch {
    // Fallback: tag-only parse, no styles (identical to the pre-style engine).
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const ctx: Ctx = { blocks: [], skippedImages: 0, css: null };
    await walk(ctx, doc.body, 0);
    return { blocks: ctx.blocks, skippedImages: ctx.skippedImages };
  }
}
