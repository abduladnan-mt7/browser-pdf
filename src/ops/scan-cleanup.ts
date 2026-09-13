// Scan cleanup for the PDF engine — pure canvas image ops, no React.
// Browser-only (document.createElement('canvas')). Used as the optional
// pre-OCR step (straighter, higher-contrast pages OCR measurably better)
// and by any standalone scan-cleanup surface.
//
//   estimateSkew(canvas)        — projection-profile skew estimate, degrees
//   cleanupCanvas(canvas, opts) — deskew / auto-levels / grayscale → NEW canvas

/** Skew search range (±deg) and step. */
const SKEW_MAX_DEG = 5;
const SKEW_STEP_DEG = 0.25;
/** The skew analysis runs on a downscaled copy about this wide. */
const ANALYSIS_WIDTH = 700;
/**
 * A non-zero angle must beat the 0° row-projection variance by this factor,
 * otherwise we call the page straight — rotating an already-straight scan by
 * a noise-picked 0.25° only blurs the raster.
 */
const MIN_GAIN_OVER_ZERO = 1.02;

export interface CleanupOptions {
  /** Rotate by -estimateSkew() so text lines run horizontally. */
  deskew?: boolean;
  /** Percentile auto-levels: clip 1% shadows / 1% highlights, stretch to full range. */
  enhance?: boolean;
  /** Collapse to luminance (Rec.601). */
  grayscale?: boolean;
}

/**
 * Estimate page skew in degrees, in [-SKEW_MAX_DEG, +SKEW_MAX_DEG].
 * Positive = content is rotated clockwise on screen (text lines drift
 * downward left→right); the fix is rotating the canvas by the NEGATIVE of
 * this value.
 *
 * Method (projection profile): downscale to ~700px wide grayscale, binarize
 * at threshold = mean·0.85, then for each candidate angle shear-project the
 * ink pixels onto rows (row = y − x·tanθ) and measure the variance of the
 * row histogram. Straight text lines collapse into few dense rows → maximum
 * variance. Ink coordinates are extracted once, so the whole search is
 * O(steps × inkPixels) on the small image — no per-angle canvas rotation.
 */
export function estimateSkew(canvas: HTMLCanvasElement): number {
  const scale = Math.min(1, ANALYSIS_WIDTH / Math.max(1, canvas.width));
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));

  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(canvas, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  // Grayscale + mean in one pass (Rec.601, integer weights /256).
  const gray = new Uint8Array(w * h);
  let sum = 0;
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const v = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8;
    gray[i] = v;
    sum += v;
  }
  const threshold = (sum / gray.length) * 0.85;

  // Ink (dark) pixel coordinates, extracted once.
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (gray[row + x] < threshold) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  const n = xs.length;
  // Blank page (or solid ink) — nothing to align on.
  if (n === 0 || n === gray.length) return 0;

  const maxShift = Math.ceil(w * Math.tan((SKEW_MAX_DEG * Math.PI) / 180)) + 2;
  const rows = h + 2 * maxShift;
  const hist = new Float64Array(rows);

  // Candidate angles sorted by |angle| so ties resolve to the smallest skew.
  const steps = Math.round((2 * SKEW_MAX_DEG) / SKEW_STEP_DEG);
  const angles: number[] = [];
  for (let k = 0; k <= steps; k++) angles.push(-SKEW_MAX_DEG + k * SKEW_STEP_DEG);
  angles.sort((a, b) => Math.abs(a) - Math.abs(b));

  const mean = n / rows;
  let bestAngle = 0;
  let bestVar = -1;
  let zeroVar = 0;

  for (const angle of angles) {
    const t = Math.tan((angle * Math.PI) / 180);
    hist.fill(0);
    for (let i = 0; i < n; i++) {
      // row index is non-negative by construction (maxShift margin).
      hist[(ys[i] - xs[i] * t + maxShift + 0.5) | 0]++;
    }
    let variance = 0;
    for (let r = 0; r < rows; r++) {
      const d = hist[r] - mean;
      variance += d * d;
    }
    variance /= rows;

    if (angle === 0) zeroVar = variance;
    if (variance > bestVar) {
      bestVar = variance;
      bestAngle = angle;
    }
  }

  if (bestAngle !== 0 && bestVar < zeroVar * MIN_GAIN_OVER_ZERO) return 0;
  return bestAngle;
}

/**
 * Clean a scanned page. Always returns a NEW canvas (the input is never
 * mutated). Pass order: deskew → enhance → grayscale.
 */
export function cleanupCanvas(canvas: HTMLCanvasElement, opts: CleanupOptions): HTMLCanvasElement {
  const angle = opts.deskew ? estimateSkew(canvas) : 0;
  // Rotation by -angle undoes the detected clockwise skew. White fill first —
  // the corners uncovered by the rotated bitmap should read as paper.
  const out = rotatedCopy(canvas, -angle);

  if (opts.enhance || opts.grayscale) {
    const ctx = out.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      const image = ctx.getImageData(0, 0, out.width, out.height);
      if (opts.enhance) autoLevels(image.data);
      if (opts.grayscale) toGrayscale(image.data);
      ctx.putImageData(image, 0, 0);
    }
  }
  return out;
}

/** Copy `src` rotated by `deg` degrees (clockwise-positive) onto white, same dimensions. */
function rotatedCopy(src: HTMLCanvasElement, deg: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext('2d');
  if (!ctx) return out;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  if (deg !== 0) {
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
  } else {
    ctx.drawImage(src, 0, 0);
  }
  return out;
}

/**
 * Percentile auto-levels in place: find the 1st/99th percentile of the
 * luminance histogram and stretch that window to 0–255 (applied per RGB
 * channel through one LUT). Lifts washed-out scans without letting single
 * hot/dead pixels dictate the range.
 */
function autoLevels(data: Uint8ClampedArray): void {
  const hist = new Uint32Array(256);
  const pixels = data.length / 4;
  for (let p = 0; p < data.length; p += 4) {
    hist[(data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8]++;
  }

  const clip = pixels * 0.01;
  let lo = 0;
  for (let acc = 0; lo < 255; lo++) {
    acc += hist[lo];
    if (acc > clip) break;
  }
  let hi = 255;
  for (let acc = 0; hi > 0; hi--) {
    acc += hist[hi];
    if (acc > clip) break;
  }
  if (hi <= lo) return; // degenerate histogram — leave untouched

  const lut = new Uint8ClampedArray(256);
  const span = 255 / (hi - lo);
  for (let v = 0; v < 256; v++) lut[v] = (v - lo) * span;

  for (let p = 0; p < data.length; p += 4) {
    data[p] = lut[data[p]];
    data[p + 1] = lut[data[p + 1]];
    data[p + 2] = lut[data[p + 2]];
  }
}

/** Replace RGB with Rec.601 luminance in place. */
function toGrayscale(data: Uint8ClampedArray): void {
  for (let p = 0; p < data.length; p += 4) {
    const y = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8;
    data[p] = y;
    data[p + 1] = y;
    data[p + 2] = y;
  }
}
