/**
 * §13.4 scan-robustness bench — corpus generation.
 *
 * Produces the ground truth the bench measures against: every §4.11 fixture plus
 * synthetic §4.1-grammar-valid VINs, each rendered as a barcode at door-jamb-label
 * proportions in the four §4.6 symbologies (plus the ANSI MH10.8.2 `I` data-identifier
 * variant of Code 39 that §9-S1 calls out).
 *
 * Everything here is DETERMINISTIC: one fixed seed, a PRNG written out below, no clock
 * reads, no `Math.random`. The bench is a gate — a corpus that shifts between runs makes
 * every downstream false-accept number meaningless.
 *
 * VIN facts are never re-derived here (P2): the grammar and the check digit come from
 * `src/lib/vin/`.
 */

import type { Buffer } from "node:buffer";
import process from "node:process";
import { toBuffer } from "bwip-js/node";
import { expectedCheckDigit, isCheckDigitValid } from "../src/lib/vin/checkDigit";
import { isVinGrammarValid, VIN_LENGTH } from "../src/lib/vin/grammar";

export type BenchSymbology = "code_39" | "code_39_i" | "code_128" | "data_matrix" | "qr_code";

/**
 * §4.6 priority order — CODE_39, CODE_128, DATA_MATRIX, QR_CODE — with the `I`-prefixed
 * Code 39 variant next to the plain one it varies.
 */
export const BENCH_SYMBOLOGIES: readonly BenchSymbology[] = [
  "code_39",
  "code_39_i",
  "code_128",
  "data_matrix",
  "qr_code",
];

export interface CorpusItem {
  /** Ground truth: the 17-character VIN, never the encoded text (see `code_39_i`). */
  vin: string;
  symbology: BenchSymbology;
  png: Buffer;
}

/**
 * §4.11 fixtures that are 17 characters and §4.1-grammar-valid, so they can be a VIN a
 * barcode carries. Two §4.11 entries are deliberately absent:
 *
 * - `I1HGCM82633A004352` is 18 characters and contains `I`. It is not a VIN, it is the
 *   `I` data-identifier *rendering* of `1HGCM82633A004352` — it appears in this corpus as
 *   the `code_39_i` symbology of that VIN, which is where it belongs.
 * - `1HGCM82633A004353` is kept (see below) but is never produced synthetically.
 *
 * `1HGCM826X3A004350` carries an `X` check digit, and `11111111111111111` is the
 * degenerate all-ones VIN — both are check-digit valid and both stress a decoder
 * differently from the ordinary case, so both stay.
 */
const FIXTURE_VINS: readonly string[] = [
  "1HGCM82633A004352",
  "11111111111111111",
  "1HGCM82633A004353",
  "1HGCM826X3A004350",
  "1FUJGLDR49SAV1234",
  "1HTMMAAL67H412345",
  "4V4NC9TJ98N412345",
  "1FUJA6CK14LM12345",
];

/**
 * The one §4.11 fixture whose check digit is deliberately wrong. It stays in the corpus —
 * a decoder must read what the label actually says, and §6.3 confirmation on a VIN that
 * fails §4.3 is exactly the path this bench exists to watch — but it is excluded from the
 * synthetic set and exempted from the check-digit assertion below.
 */
const FIXTURE_BAD_CHECK_DIGIT = "1HGCM82633A004353";

/** §4.1 alphabet: A–Z and 0–9 excluding I, O and Q. */
const VIN_ALPHABET = "0123456789ABCDEFGHJKLMNPRSTUVWXYZ";

/** Position 9, zero-indexed (§4.3). */
const CHECK_DIGIT_INDEX = 8;

/** Fixed corpus seed. Changing it changes every synthetic VIN, so it does not change. */
const CORPUS_SEED = 0x5c17_9e2d;

/**
 * mulberry32. Written out rather than imported so the bench owns its randomness and no
 * dependency bump can move the corpus underneath a recorded result.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One synthetic VIN: 17 alphabet characters, then position 9 forced to §4.3. */
function synthesizeVin(rand: () => number): string {
  const chars: string[] = [];
  for (let i = 0; i < VIN_LENGTH; i += 1) {
    chars.push(VIN_ALPHABET[Math.floor(rand() * VIN_ALPHABET.length)]);
  }
  const draft = chars.join("");
  return (
    draft.slice(0, CHECK_DIGIT_INDEX) +
    expectedCheckDigit(draft) +
    draft.slice(CHECK_DIGIT_INDEX + 1)
  );
}

/**
 * `count` VINs: the §4.11 fixtures first, then synthetic ones, deduplicated. Deterministic
 * for a given `count`, and a prefix-stable sequence, so `corpusVins(8)` is the first eight
 * of `corpusVins(200)`.
 */
export function corpusVins(count: number): string[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`corpusVins: count must be a non-negative integer, got ${count}`);
  }

  const seen = new Set<string>();
  const vins: string[] = [];
  const push = (vin: string): void => {
    if (seen.has(vin)) return;
    seen.add(vin);
    vins.push(vin);
  };

  for (const vin of FIXTURE_VINS) {
    if (vins.length >= count) break;
    push(vin);
  }

  const rand = mulberry32(CORPUS_SEED);
  /** Duplicates are astronomically unlikely, but a bounded loop cannot hang the gate. */
  const maxAttempts = Math.max(1024, count * 64);
  for (let attempt = 0; vins.length < count && attempt < maxAttempts; attempt += 1) {
    const vin = synthesizeVin(rand);
    if (vin === FIXTURE_BAD_CHECK_DIGIT) continue;
    push(vin);
  }
  if (vins.length < count) {
    throw new Error(`corpusVins: could not produce ${count} distinct VINs`);
  }

  for (const vin of vins) {
    if (!isVinGrammarValid(vin)) {
      throw new Error(`corpusVins: ${vin} is not §4.1 grammar-valid`);
    }
    if (vin !== FIXTURE_BAD_CHECK_DIGIT && !isCheckDigitValid(vin)) {
      throw new Error(`corpusVins: ${vin} fails the §4.3 check digit`);
    }
  }

  return vins;
}

/**
 * Label-realistic geometry. A door-jamb barcode is roughly 50–70 mm wide and 8–15 mm tall,
 * photographed close enough to fill much of the frame, so the 1D symbols are rendered
 * around 1050 px wide with a bar height around 190 px — an aspect ratio of about 5.5:1,
 * i.e. ~11 mm of bar across ~60 mm of label.
 *
 * Physical width is what a printed label fixes, not module width, so the module scale is
 * chosen per symbol to land on a common width. Code 128 in particular swings between ~145
 * and ~230 modules depending on how many digit pairs a VIN offers.
 */
const LINEAR_TARGET_WIDTH_PX = 1050;
const LINEAR_MIN_WIDTH_PX = 900;
const LINEAR_MAX_WIDTH_PX = 1200;

/**
 * Bar height in bwip-js millimetres at 72 dpi (1 mm = 2.8346 px), applied with `scaleY: 1`
 * so it stays fixed while `scaleX` varies. 67 mm renders as ~190 px.
 */
const LINEAR_BAR_HEIGHT_MM = 67;

/** White space above and below the bars, in pixels at `scaleY: 1`. */
const LINEAR_PADDING_Y = 28;

const MATRIX_TARGET_PX = 500;
const MATRIX_MIN_PX = 400;
const MATRIX_MAX_PX = 600;

interface RenderSpec {
  /** bwip-js `bcid`. */
  bcid: string;
  /** What actually gets encoded, which is not always the VIN. */
  encode: (vin: string) => string;
  kind: "linear" | "matrix";
  /**
   * Quiet zone per side, in bwip-js padding units (1 module for 1D symbols, half a module
   * for 2D symbols). A symbol rendered flush to its edge fails to decode for reasons that
   * have nothing to do with degradation, which would poison the clean tier.
   */
  quiet: number;
}

const RENDER_SPECS: Readonly<Record<BenchSymbology, RenderSpec>> = {
  /** The most common door-jamb symbology. */
  code_39: { bcid: "code39", encode: (vin) => vin, kind: "linear", quiet: 12 },
  /**
   * §9-S1: the ANSI MH10.8.2 `I` data identifier printed on real labels. The ground truth
   * stays the bare VIN — stripping the `I` is §4.2's job, and this row is how the bench
   * proves it happens.
   */
  code_39_i: { bcid: "code39", encode: (vin) => `I${vin}`, kind: "linear", quiet: 12 },
  code_128: { bcid: "code128", encode: (vin) => vin, kind: "linear", quiet: 12 },
  /** DataMatrix asks 2 modules of quiet zone; 4 padding units is 2 modules. */
  data_matrix: { bcid: "datamatrix", encode: (vin) => vin, kind: "matrix", quiet: 4 },
  /** QR asks 4 modules of quiet zone; 8 padding units is 4 modules. */
  qr_code: { bcid: "qrcode", encode: (vin) => vin, kind: "matrix", quiet: 8 },
};

interface BwipOptions {
  bcid: string;
  text: string;
  scaleX: number;
  scaleY: number;
  height?: number;
  includetext: boolean;
  paddingwidth: number;
  paddingheight: number;
  barcolor: string;
  backgroundcolor: string;
}

function baseOptions(spec: RenderSpec, vin: string): Omit<BwipOptions, "scaleX" | "scaleY"> {
  return {
    bcid: spec.bcid,
    text: spec.encode(vin),
    ...(spec.kind === "linear" ? { height: LINEAR_BAR_HEIGHT_MM } : {}),
    /** No human-readable line: the decoder must not be able to cheat by reading OCR text. */
    includetext: false,
    paddingwidth: spec.quiet,
    paddingheight: spec.kind === "linear" ? LINEAR_PADDING_Y : spec.quiet,
    /** Black bars on white. An unset background renders transparent, which degrades badly. */
    barcolor: "000000",
    backgroundcolor: "FFFFFF",
  };
}

/**
 * Width and height from the PNG IHDR chunk: an 8-byte signature, a 4-byte length, the
 * four-byte type, then two big-endian uint32s. Cheaper and more deterministic than
 * decoding the image, and bwip-js always emits a conformant PNG.
 */
function pngSize(png: Buffer): { width: number; height: number } {
  const PNG_MAGIC = "\x89PNG\r\n\x1a\n";
  if (png.length < 24 || png.toString("latin1", 0, 8) !== PNG_MAGIC) {
    throw new Error("pngSize: not a PNG");
  }
  if (png.toString("latin1", 12, 16) !== "IHDR") {
    throw new Error("pngSize: first chunk is not IHDR");
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * bwip-js output scales exactly linearly in `scaleX`, padding included, so one probe
 * render at scale 1 is enough to pick the integer scale that lands closest to `target`
 * while staying inside `[min, max]`. Integer scaling keeps module edges pixel-aligned;
 * resampling to an exact width would blur the clean tier.
 */
function chooseScale(baseWidth: number, target: number, min: number, max: number): number {
  let best = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestInRange = false;
  for (let scale = 1; scale <= 64; scale += 1) {
    const width = baseWidth * scale;
    const inRange = width >= min && width <= max;
    const distance = Math.abs(width - target);
    if (inRange && !bestInRange) {
      best = scale;
      bestDistance = distance;
      bestInRange = true;
    } else if (inRange === bestInRange && distance < bestDistance) {
      best = scale;
      bestDistance = distance;
    }
  }
  return best;
}

export async function renderBarcode(vin: string, symbology: BenchSymbology): Promise<Buffer> {
  const spec = RENDER_SPECS[symbology];
  const options = baseOptions(spec, vin);

  const probe = await toBuffer({ ...options, scaleX: 1, scaleY: 1 });
  const probeSize = pngSize(probe);

  const linear = spec.kind === "linear";
  const scale = linear
    ? chooseScale(probeSize.width, LINEAR_TARGET_WIDTH_PX, LINEAR_MIN_WIDTH_PX, LINEAR_MAX_WIDTH_PX)
    : chooseScale(probeSize.width, MATRIX_TARGET_PX, MATRIX_MIN_PX, MATRIX_MAX_PX);

  const png = await toBuffer({ ...options, scaleX: scale, scaleY: linear ? 1 : scale });
  const size = pngSize(png);

  const minWidth = linear ? LINEAR_MIN_WIDTH_PX : MATRIX_MIN_PX;
  const maxWidth = linear ? LINEAR_MAX_WIDTH_PX : MATRIX_MAX_PX;
  if (size.width < minWidth || size.width > maxWidth) {
    throw new Error(
      `renderBarcode: ${symbology} of ${vin} rendered ${size.width}px wide, ` +
        `outside the label-realistic ${minWidth}–${maxWidth}px band`,
    );
  }

  return png;
}

/** Bounded so a 200-VIN corpus (1000 renders) does not hold every PNG-in-flight at once. */
const RENDER_CONCURRENCY = 8;

/**
 * `count` VINs crossed with every §13.4 symbology, in `corpusVins` order then
 * `BENCH_SYMBOLOGIES` order. Progress goes to stderr so stdout stays parseable.
 */
export async function buildCorpus(count: number): Promise<CorpusItem[]> {
  const vins = corpusVins(count);
  const jobs: { vin: string; symbology: BenchSymbology }[] = [];
  for (const vin of vins) {
    for (const symbology of BENCH_SYMBOLOGIES) {
      jobs.push({ vin, symbology });
    }
  }

  const items = new Array<CorpusItem>(jobs.length);
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= jobs.length) return;
      const job = jobs[index];
      items[index] = {
        vin: job.vin,
        symbology: job.symbology,
        png: await renderBarcode(job.vin, job.symbology),
      };
      done += 1;
      if (done % 25 === 0 || done === jobs.length) {
        process.stderr.write(`corpus: rendered ${done}/${jobs.length}\n`);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(RENDER_CONCURRENCY, jobs.length) }, () => worker()),
  );

  return items;
}
