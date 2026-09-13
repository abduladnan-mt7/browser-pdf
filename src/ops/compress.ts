// Smart Compress op: shrink a PDF by downsampling + re-encoding the raster
// images embedded inside it, leaving text and vector content untouched (so
// the result stays selectable/searchable). Always-smaller guarantee: when the
// rewritten file wouldn't be smaller than the input, the caller gets the
// original bytes back with `usedOriginal: true` and can say so honestly.
//
// The actual pixel work (decode → downscale → JPEG encode) lives behind an
// injectable `recodeImage` function so the walker is testable in Node; the
// browser default (`canvasRecoder`) uses createImageBitmap + canvas.

import type { PDFContext, PDFDict, PDFObject, PDFRawStream, PDFRef } from '@cantoo/pdf-lib';
import { openPdf } from '../session';

type PdfLib = typeof import('@cantoo/pdf-lib');

export type CompressPreset = 'high' | 'balanced' | 'extreme';

/** Shape of a decompressed FlateDecode bitmap handed to the recoder. */
export interface RawImageInfo {
  width: number;
  height: number;
  colorSpace: 'rgb' | 'gray';
}

/** What a recoder returns: JPEG bytes plus the (possibly downscaled) dims. */
export interface RecodedImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/**
 * Pixel worker: gets either a complete JPEG file (`kind: 'jpeg'`) or raw
 * decompressed 8-bit RGB/Gray rows (`kind: 'raw'`, with `raw` describing the
 * layout), and returns re-encoded JPEG bytes — or null when it can't decode
 * (caller counts the image as skipped).
 */
export type RecodeImage = (
  imgBytes: Uint8Array,
  kind: 'jpeg' | 'raw',
  raw?: RawImageInfo,
  opts?: { maxDim: number; quality: number },
) => Promise<RecodedImage | null>;

export interface CompressResult {
  /** Output bytes (or the original input when `usedOriginal`). */
  bytes: Uint8Array;
  originalSize: number;
  newSize: number;
  imagesRecompressed: number;
  /** CMYK / predictors / masks / tiny / already-smaller-than-recode images. */
  imagesSkipped: number;
  /** True → rewriting didn't shrink the file, so the original was kept. */
  usedOriginal: boolean;
}

const PRESETS: Record<CompressPreset, { maxDim: number; quality: number }> = {
  high: { maxDim: 2048, quality: 0.82 },
  balanced: { maxDim: 1600, quality: 0.72 },
  extreme: { maxDim: 1100, quality: 0.58 },
};

// Below either threshold recompression can't win enough to matter.
const MIN_PIXELS = 320 * 320;
const MIN_STREAM_BYTES = 24 * 1024;

/**
 * Recompress the images inside a PDF. Text/vectors are never touched; each
 * image stream is only replaced when its re-encoded version is smaller, and
 * the whole file is only replaced when the final save is smaller than the
 * input. Encrypted files need `password` (else PdfEncryptedError, from
 * openPdf); note the output is saved decrypted.
 */
export async function compressPdf(
  bytes: Uint8Array,
  opts: {
    preset: CompressPreset;
    password?: string;
    onProgress?: (done: number, total: number) => void;
    /** Injectable for Node tests; defaults to the browser canvas recoder. */
    recodeImage?: RecodeImage;
  },
): Promise<CompressResult> {
  const originalSize = bytes.length;
  const { maxDim, quality } = PRESETS[opts.preset];
  const recode = opts.recodeImage ?? canvasRecoder;

  const lib = await import('@cantoo/pdf-lib');
  // openPdf maps failures onto the engine taxonomy: encrypted (or wrong
  // password) → PdfEncryptedError, anything else → PdfCorruptError.
  const { doc } = await openPdf(bytes, 'document.pdf', undefined, opts.password);
  const context = doc.context;

  // Pass 1 — collect image XObject streams, and the refs used as masks so we
  // never touch a stream that IS a soft/stencil mask (base images that merely
  // HAVE an /SMask are fair game; the mask scales independently per spec).
  const images: Array<{ ref: PDFRef; stream: PDFRawStream }> = [];
  const maskRefs = new Set<PDFRef>();
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof lib.PDFRawStream)) continue;
    if (obj.dict.get(lib.PDFName.of('Subtype')) !== lib.PDFName.of('Image')) continue;
    images.push({ ref, stream: obj });
    for (const key of ['SMask', 'Mask']) {
      const mask = obj.dict.get(lib.PDFName.of(key));
      if (mask instanceof lib.PDFRef) maskRefs.add(mask);
    }
  }

  let recompressed = 0;
  let skipped = 0;
  let done = 0;
  opts.onProgress?.(0, images.length);

  for (const { ref, stream } of images) {
    const replaced = maskRefs.has(ref)
      ? false
      : await tryRecompressImage(lib, context, ref, stream, recode, maxDim, quality);
    if (replaced) recompressed++;
    else skipped++;
    opts.onProgress?.(++done, images.length);
  }

  if (recompressed > 0) {
    const out = await doc.save({ useObjectStreams: true });
    if (out.length < originalSize) {
      return {
        bytes: out,
        originalSize,
        newSize: out.length,
        imagesRecompressed: recompressed,
        imagesSkipped: skipped,
        usedOriginal: false,
      };
    }
  }

  // Nothing shrank (or nothing was recompressible) — keep the original.
  return {
    bytes,
    originalSize,
    newSize: originalSize,
    imagesRecompressed: recompressed,
    imagesSkipped: skipped,
    usedOriginal: true,
  };
}

/** Recompress one image stream in place. Returns true when it was replaced. */
async function tryRecompressImage(
  lib: PdfLib,
  context: PDFContext,
  ref: PDFRef,
  stream: PDFRawStream,
  recode: RecodeImage,
  maxDim: number,
  quality: number,
): Promise<boolean> {
  const dict = stream.dict;
  const name = lib.PDFName.of.bind(lib.PDFName);

  // Stencil masks and external-file streams: leave alone.
  if (dict.get(name('ImageMask')) === lib.PDFBool.True) return false;
  if (dict.has(name('F')) || dict.has(name('FFilter'))) return false;

  const filter = singleFilter(lib, context, dict);
  if (!filter) return false;

  const width = dictNumber(lib, context, dict, 'Width');
  const height = dictNumber(lib, context, dict, 'Height');
  if (!width || !height) return false;

  const contents = stream.getContents();
  if (width * height <= MIN_PIXELS || contents.length < MIN_STREAM_BYTES) return false;

  const cs = classifyColorSpace(lib, context, dict);
  let result: RecodedImage | null = null;

  if (filter === name('DCTDecode')) {
    // Contents are a complete JPEG file. CMYK JPEGs skip (browser decode is
    // unreliable), as do custom /Decode arrays (canvas wouldn't apply them).
    if (cs.kind !== 'rgb' && cs.kind !== 'gray') return false;
    if (dict.has(name('Decode'))) return false;
    result = await recode(contents, 'jpeg', undefined, { maxDim, quality });
  } else if (filter === name('FlateDecode')) {
    // Raw bitmap. Only the plain layouts we can rebuild pixel-for-pixel:
    // no predictors/decode arrays, 8 bits/component, device RGB or Gray.
    if (dict.has(name('DecodeParms')) || dict.has(name('DP')) || dict.has(name('Decode'))) return false;
    if (dictNumber(lib, context, dict, 'BitsPerComponent') !== 8) return false;
    if ((cs.kind !== 'rgb' && cs.kind !== 'gray') || !cs.device) return false;

    const inflated = await inflateZlib(contents);
    if (!inflated) return false;
    const channels = cs.kind === 'rgb' ? 3 : 1;
    if (inflated.length !== width * height * channels) return false; // unexpected layout
    result = await recode(inflated, 'raw', { width, height, colorSpace: cs.kind }, { maxDim, quality });
  } else {
    return false; // JPX, JBIG2, CCITT, LZW, … — not worth the risk
  }

  if (!result || result.bytes.length >= contents.length) return false;

  // Rebuild the dict: clone (keeps /SMask, /Intent, /OC, /StructParent, …),
  // then rewrite the entries the new JPEG payload dictates. /Length is
  // recomputed from the contents automatically at save time.
  const newDict = dict.clone();
  newDict.set(name('Filter'), name('DCTDecode'));
  newDict.set(name('Width'), lib.PDFNumber.of(result.width));
  newDict.set(name('Height'), lib.PDFNumber.of(result.height));
  newDict.set(name('ColorSpace'), name('DeviceRGB'));
  newDict.set(name('BitsPerComponent'), lib.PDFNumber.of(8));
  newDict.delete(name('DecodeParms'));
  newDict.delete(name('DP'));
  newDict.delete(name('Decode'));
  context.assign(ref, lib.PDFRawStream.of(newDict, result.bytes));
  return true;
}

/** The stream's filter when it's a single name (directly or a 1-element array). */
function singleFilter(lib: PdfLib, context: PDFContext, dict: PDFDict): PDFObject | undefined {
  const filter = resolve(lib, context, dict.get(lib.PDFName.of('Filter')));
  if (filter instanceof lib.PDFName) return filter;
  if (filter instanceof lib.PDFArray && filter.size() === 1) {
    const first = resolve(lib, context, filter.get(0));
    if (first instanceof lib.PDFName) return first;
  }
  return undefined;
}

type CsClass = { kind: 'rgb' | 'gray'; device: boolean } | { kind: 'cmyk' | 'other'; device?: undefined };

function classifyColorSpace(lib: PdfLib, context: PDFContext, dict: PDFDict): CsClass {
  const cs = resolve(lib, context, dict.get(lib.PDFName.of('ColorSpace')));
  if (cs instanceof lib.PDFName) {
    if (cs === lib.PDFName.of('DeviceRGB')) return { kind: 'rgb', device: true };
    if (cs === lib.PDFName.of('DeviceGray')) return { kind: 'gray', device: true };
    if (cs === lib.PDFName.of('DeviceCMYK')) return { kind: 'cmyk' };
    return { kind: 'other' };
  }
  if (cs instanceof lib.PDFArray && cs.size() >= 1) {
    const family = resolve(lib, context, cs.get(0));
    if (family === lib.PDFName.of('ICCBased') && cs.size() >= 2) {
      const profile = resolve(lib, context, cs.get(1));
      const n = profile instanceof lib.PDFStream
        ? dictNumber(lib, context, profile.dict, 'N')
        : undefined;
      if (n === 3) return { kind: 'rgb', device: false };
      if (n === 1) return { kind: 'gray', device: false };
      if (n === 4) return { kind: 'cmyk' };
      return { kind: 'other' };
    }
    if (family === lib.PDFName.of('CalRGB')) return { kind: 'rgb', device: false };
    if (family === lib.PDFName.of('CalGray')) return { kind: 'gray', device: false };
    return { kind: 'other' }; // Indexed, Separation, DeviceN, Lab, Pattern, …
  }
  return { kind: 'other' };
}

const resolve = (lib: PdfLib, context: PDFContext, obj: PDFObject | undefined): PDFObject | undefined =>
  obj instanceof lib.PDFRef ? context.lookup(obj) : obj;

function dictNumber(lib: PdfLib, context: PDFContext, dict: PDFDict, key: string): number | undefined {
  const v = resolve(lib, context, dict.get(lib.PDFName.of(key)));
  return v instanceof lib.PDFNumber ? v.asNumber() : undefined;
}

/** Inflate zlib-wrapped FlateDecode data. DecompressionStream: browsers + Node 18+. */
async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Browser default recoder: decode via createImageBitmap (JPEG) or ImageData
 * (raw rows), downscale so max(w, h) ≤ maxDim (never upscale), flatten onto
 * white (JPEG has no alpha), encode with canvas.toBlob. Returns null on any
 * failure so the caller counts the image as skipped.
 */
export const canvasRecoder: RecodeImage = async (imgBytes, kind, raw, opts) => {
  if (typeof document === 'undefined') return null;
  const maxDim = opts?.maxDim ?? PRESETS.balanced.maxDim;
  const quality = opts?.quality ?? PRESETS.balanced.quality;
  try {
    const source = kind === 'jpeg' ? await decodeJpeg(imgBytes) : rawToCanvas(raw, imgBytes);
    if (!source) return null;

    const scale = Math.min(1, maxDim / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source.src, 0, 0, width, height);
    if (source.src instanceof ImageBitmap) source.src.close();

    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', quality));
    if (!blob) return null;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
  } catch {
    return null;
  }
};

type DecodedSource = { src: CanvasImageSource; width: number; height: number };

async function decodeJpeg(bytes: Uint8Array): Promise<DecodedSource | null> {
  const blob = new Blob([bytes.slice()], { type: 'image/jpeg' });
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      return { src: bmp, width: bmp.width, height: bmp.height };
    } catch {
      // fall through to <img> decode
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    const loaded = await new Promise<boolean>((res) => {
      img.onload = () => res(true);
      img.onerror = () => res(false);
      img.src = url;
    });
    if (!loaded || !img.naturalWidth) return null;
    return { src: img, width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function rawToCanvas(raw: RawImageInfo | undefined, bytes: Uint8Array): DecodedSource | null {
  if (!raw) return null;
  const { width, height, colorSpace } = raw;
  const channels = colorSpace === 'rgb' ? 3 : 1;
  if (width < 1 || height < 1 || bytes.length < width * height * channels) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const image = ctx.createImageData(width, height);
  const px = image.data;
  for (let i = 0, o = 0; i < width * height; i++, o += 4) {
    if (colorSpace === 'rgb') {
      px[o] = bytes[i * 3];
      px[o + 1] = bytes[i * 3 + 1];
      px[o + 2] = bytes[i * 3 + 2];
    } else {
      px[o] = px[o + 1] = px[o + 2] = bytes[i];
    }
    px[o + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return { src: canvas, width, height };
}
