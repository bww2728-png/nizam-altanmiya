'use strict';

/**
 * Local Arabic OCR pipeline.
 *
 * The 0.3.0 reader handed the raw bytes straight to Tesseract with default
 * parameters. That leaves most of the accuracy on the table for scanned forms:
 * no upscaling to a sane DPI, no contrast normalisation, no deskew, no page
 * segmentation hint, no per-line confidence, no cancellation. This module adds
 * exactly those, locally, with no new dependency (the same canvas and tesseract
 * builds already shipped with the app).
 *
 * Everything here is a *proposal generator*: nothing is written to the store.
 */

const path = require('node:path');
const { createWorker } = require('tesseract.js');

const TARGET_DPI = 300;
/** Longest edge after preprocessing. A4 @300dpi is 3508px; more is wasted work. */
const MAX_EDGE = 3508;
/** Refuse to blow up a tiny thumbnail into a blurry 3500px image. */
const MAX_UPSCALE = 3.2;
/** Below this engine confidence a line/field is flagged for human review. */
const REVIEW_CONFIDENCE = 0.6;

/** Page-segmentation modes. 6 = uniform block (forms), 4 = single column. */
const PSM = { AUTO: '3', SINGLE_COLUMN: '4', SINGLE_BLOCK: '6', SINGLE_LINE: '7' };

let workerPromise = null;
let progressListener = null;
let activeGeneration = 0;

function langPath() {
  // The package ships `4.0.0` and `4.0.0_best_int`. The integer ("best") model
  // is markedly better on Arabic ligatures, and it is already in the bundle.
  const data = require('@tesseract.js-data/ara');
  return path.join(path.dirname(data.langPath), '4.0.0_best_int');
}

async function getWorker() {
  if (!workerPromise) {
    const generation = ++activeGeneration;
    workerPromise = (async () => {
      const worker = await createWorker('ara', 1, {
        langPath: langPath(),
        gzip: true,
        logger: (message) => {
          if (generation !== activeGeneration) return;
          if (progressListener) {
            try { progressListener(message); } catch { /* listener must not break OCR */ }
          }
        },
      });
      await worker.setParameters({
        preserve_interword_spaces: '1',
        user_defined_dpi: String(TARGET_DPI),
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      });
      return worker;
    })().catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

/**
 * Terminate the cached worker (used by cancellation and by app shutdown).
 * The next recognition creates a fresh one.
 */
async function disposeWorker() {
  const pending = workerPromise;
  workerPromise = null;
  activeGeneration += 1;
  if (!pending) return;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch { /* already dead */ }
}

/**
 * Cancel whatever recognition is running right now. Tesseract.js has no
 * cooperative cancel, so the worker is torn down; the caller's promise rejects
 * and the next call starts clean.
 */
async function cancelRecognition() {
  await disposeWorker();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Encode the prepared page for recognition.
 *
 * PNG, not JPEG: a JPEG round-trip cost ~0.5 s less per page but cost two fields
 * on a mildly skewed page in the benchmark (lossy edges merge thin Arabic
 * strokes). Pixel-exact encoding is the cheaper trade at this scale.
 */
function encodePrepared(canvas) {
  return canvas.toBuffer('image/png');
}

/**
 * Estimate the skew of a binarised image by maximising the variance of the row
 * sums of a downscaled copy (classic projection-profile deskew).
 *
 * @returns {number} angle in degrees, positive = counter-clockwise
 */
function estimateSkew(gray, width, height) {
  const size = 480;
  const scale = Math.min(1, size / Math.max(width, height));
  const w = Math.max(8, Math.round(width * scale));
  const h = Math.max(8, Math.round(height * scale));
  const sample = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const sy = Math.min(height - 1, Math.floor(y / scale));
      sample[y * w + x] = gray[sy * width + sx] < 128 ? 1 : 0;
    }
  }

  let bestAngle = 0;
  let bestScore = -1;
  for (let angle = -6; angle <= 6; angle += 0.5) {
    const radians = (angle * Math.PI) / 180;
    const tan = Math.tan(radians);
    const rows = new Float32Array(h);
    for (let y = 0; y < h; y += 1) {
      let sum = 0;
      for (let x = 0; x < w; x += 1) {
        const sy = Math.round(y - (x - w / 2) * tan);
        if (sy >= 0 && sy < h) sum += sample[sy * w + x];
      }
      rows[y] = sum;
    }
    let mean = 0;
    for (let y = 0; y < h; y += 1) mean += rows[y];
    mean /= h;
    let variance = 0;
    for (let y = 0; y < h; y += 1) variance += (rows[y] - mean) ** 2;
    variance /= h;
    if (variance > bestScore) {
      bestScore = variance;
      bestAngle = angle;
    }
  }
  return bestAngle;
}

/**
 * Normalise a scanned image before recognition:
 *   - upscale small inputs toward 300 DPI (A4 ≈ 3508px longest edge)
 *   - grayscale + percentile contrast stretch (removes grey paper casts)
 *   - deskew by projection profile when the skew is measurable
 *
 * @param {Buffer|Uint8Array} input
 * @returns {Promise<{buffer:Buffer, width:number, height:number, angle:number, upscale:number, contrast:number}>}
 */
async function preprocessImage(input) {
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const image = await loadImage(Buffer.isBuffer(input) ? input : Buffer.from(input));
  const sourceWidth = image.width;
  const sourceHeight = image.height;
  if (!sourceWidth || !sourceHeight) throw new Error('تعذّر قراءة أبعاد الصورة.');

  const longest = Math.max(sourceWidth, sourceHeight);
  const upscale = clamp(MAX_EDGE / longest, 1, MAX_UPSCALE);
  const width = Math.round(sourceWidth * upscale);
  const height = Math.round(sourceHeight * upscale);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, width, height);

  const raw = ctx.getImageData(0, 0, width, height);
  const data = raw.data;
  const gray = new Uint8Array(width * height);
  const histogram = new Uint32Array(256);

  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    // Rec. 709 luma: keeps Arabic strokes and thin table rules distinct.
    const value = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) | 0;
    gray[p] = value;
    histogram[value] += 1;
  }

  // Percentile contrast stretch: clip the darkest/brightest 1% so a single
  // shadow or highlight cannot flatten the whole page.
  const total = width * height;
  const lowCount = total * 0.01;
  const highCount = total * 0.99;
  let cumulative = 0;
  let low = 0;
  let high = 255;
  for (let value = 0; value < 256; value += 1) {
    cumulative += histogram[value];
    if (low === 0 && cumulative >= lowCount) low = value;
    if (cumulative >= highCount) { high = value; break; }
  }
  if (high - low < 8) { low = 0; high = 255; }
  const contrast = high - low;

  for (let p = 0; p < total; p += 1) {
    const stretched = clamp(Math.round(((gray[p] - low) * 255) / contrast), 0, 255);
    gray[p] = stretched;
  }

  const angle = estimateSkew(gray, width, height);

  // Paint the normalised grayscale back, then rotate if the page is skewed.
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const value = gray[p];
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }

  if (Math.abs(angle) >= 1 && Math.abs(angle) < 45) {
    const rotated = createCanvas(width, height);
    const rctx = rotated.getContext('2d');
    rctx.fillStyle = '#ffffff';
    rctx.fillRect(0, 0, width, height);
    rctx.translate(width / 2, height / 2);
    rctx.rotate((angle * Math.PI) / 180);
    rctx.drawImage(canvas, -width / 2, -height / 2);
    return { buffer: encodePrepared(rotated), width, height, angle, upscale, contrast };
  }

  ctx.putImageData(raw, 0, 0);
  return { buffer: encodePrepared(canvas), width, height, angle, upscale, contrast };
}

/** Rotate an already-encoded image by a multiple of 90 degrees. */
async function rotateImage(buffer, degrees) {
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const image = await loadImage(buffer);
  const radians = (degrees * Math.PI) / 180;
  const swaps = Math.abs(degrees) % 180 === 90;
  const width = swaps ? image.height : image.width;
  const height = swaps ? image.width : image.height;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.translate(width / 2, height / 2);
  ctx.rotate(radians);
  ctx.drawImage(image, -image.width / 2, -image.height / 2);
  return encodePrepared(canvas);
}

/** Flatten Tesseract's block tree into `{ text, confidence, bbox }` lines. */
function extractLines(data) {
  const lines = [];
  const blocks = data?.blocks ?? [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const text = String(line.text ?? '').replace(/\u0000/g, '').trim();
        if (!text) continue;
        lines.push({
          text,
          confidence: clamp(Number(line.confidence ?? 0) / 100, 0, 1),
          bbox: line.bbox ?? null,
        });
      }
    }
  }
  return lines;
}

/**
 * Recognise one prepared image.
 *
 * Low-confidence pages are retried at 180° (the single most common camera
 * mistake) and kept only if the retry is clearly better.
 *
 * @param {Buffer} buffer prepared PNG
 * @param {{psm?:string, onProgress?:(message:object)=>void, signal?:{aborted:boolean}}} options
 */
async function recognizeBuffer(buffer, options = {}) {
  const { psm = PSM.SINGLE_BLOCK, onProgress = null, signal = null, allowRotation = true } = options;
  if (signal?.aborted) throw new Error('أُلغي التعرف الضوئي.');

  progressListener = (message) => {
    if (!onProgress || signal?.aborted) return;
    onProgress({
      status: message.status ?? 'recognizing',
      progress: Number.isFinite(message.progress) ? message.progress : null,
    });
  };

  try {
    let best = await runOnce(buffer, psm);
    // Rotation is a last resort, not a routine step: it costs a full recognition
    // per attempt. Only an almost-unreadable page is worth that, and a page that
    // is merely "not great" is left as-is so bulk imports stay fast.
    if (allowRotation && best.confidence < 0.4) {
      for (const rotation of [180, 90, 270]) {
        if (signal?.aborted) throw new Error('أُلغي التعرف الضوئي.');
        const rotated = await rotateImage(buffer, rotation);
        const attempt = await runOnce(rotated, psm);
        if (attempt.confidence > best.confidence + 0.05) {
          best = { ...attempt, rotation };
        }
        if (best.confidence >= 0.5) break;
      }
    }
    return best;
  } finally {
    progressListener = null;
  }
}

async function runOnce(buffer, psm) {
  const worker = await getWorker();
  await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
  const result = await worker.recognize(buffer, {}, { text: true, blocks: true });
  const data = result?.data ?? {};
  const lines = extractLines(data);
  const confidence = clamp(Number(data.confidence ?? 0) / 100, 0, 1);
  return {
    text: String(data.text ?? '').replace(/\u0000/g, ''),
    confidence,
    lines,
    rotation: 0,
  };
}

/**
 * True when a PDF text layer looks unusable: a text layer that exists but is
 * mis-encoded silently bypasses OCR and produces Arabic-looking garbage, which
 * is the worst possible outcome (it is never flagged). A page is only trusted
 * when its text layer carries a plausible amount of real Arabic letters.
 */
function textLayerIsUsable(text) {
  const value = String(text ?? '');
  const stripped = value.replace(/\s/g, '');
  if (stripped.length < 4) return false;

  const letters = value.match(/[\p{L}]/gu) ?? [];
  const arabic = value.match(/[\u0621-\u064A]/g) ?? [];
  const hasArabic = arabic.length > 0;
  const words = value.split(/\s+/).filter(Boolean);
  const arabicShare = letters.length ? arabic.length / letters.length : 0;

  // Replacement characters, private-use glyphs and Arabic presentation forms
  // indicate a broken ToUnicode map rather than a silent, valid extraction.
  const suspicious = value.match(/[\uFFFD\uE000-\uF8FF\uFB50-\uFEFF]/g) ?? [];
  if (suspicious.length / Math.max(1, stripped.length) > 0.02) return false;

  // A very short layer is usually a page number or a stray header; OCR the page
  // instead of pretending that is its content.
  if (stripped.length < 12) {
    if (!letters.length) return false;
    return words.length >= 2 || hasArabic;
  }

  const averageLength = words.length ? words.join('').length / words.length : 0;
  if (words.length >= 5 && averageLength < 2.2) return false;

  // Latin pages are legitimate (donor tables); broken Arabic must not pass.
  if (hasArabic && arabicShare < 0.35) return false;
  return true;
}

module.exports = {
  TARGET_DPI,
  MAX_EDGE,
  REVIEW_CONFIDENCE,
  PSM,
  langPath,
  getWorker,
  disposeWorker,
  cancelRecognition,
  preprocessImage,
  rotateImage,
  recognizeBuffer,
  textLayerIsUsable,
  extractLines,
};