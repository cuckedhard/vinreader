/**
 * tesseract.js, configured so that nothing it loads comes from anywhere but this origin.
 *
 * Three defaults reach `cdn.jsdelivr.net` at OCR time — `workerPath`, `corePath` and
 * `langPath` — and all three are overridden here. N3 is the reason (nothing leaves the
 * device), and the offline guarantee is the other: an installed app in a parking garage
 * cannot reach a CDN, so a default left in place is a feature that works in the office and
 * fails in the field.
 *
 * `corePath` names one file rather than the directory tesseract.js documents. That is
 * deliberate and it is §4's: the directory form picks a build at runtime from what the
 * device reports, which would mean shipping four cores (14 MB) and running one nobody
 * measured. This build is pinned — single-threaded, SIMD, LSTM-only, `MAXIMUM_MEMORY`
 * 256 MB — and `support.ts` refuses the run on a device without SIMD rather than
 * downloading a core it cannot instantiate.
 *
 * The module itself is loaded from `ocr/` too, so tesseract.js is not in the app bundle
 * and not in the precache manifest: an install costs the same whether or not OCR is used.
 */
import {
  OCR_ASSET_DIR,
  OCR_CHAR_WHITELIST,
  OCR_INIT_CONFIG,
  OCR_LANG,
  OCR_OEM,
  OCR_PARAMS,
} from "./constants";
import { OcrError, type OcrChar, type OcrLine, type OcrToken } from "./types";

/** The shape `worker.recognize` returns, narrowed to what a paint code needs. */
export interface TesseractSymbol {
  text: string;
  confidence: number;
}
export interface TesseractWord {
  symbols?: TesseractSymbol[];
}
export interface TesseractLine {
  words?: TesseractWord[];
}
export interface TesseractParagraph {
  lines?: TesseractLine[];
}
export interface TesseractBlock {
  paragraphs?: TesseractParagraph[];
}
export interface TesseractPage {
  text: string;
  confidence: number;
  blocks?: TesseractBlock[] | null;
}

export interface TesseractWorkerLike {
  setParameters(params: Record<string, string>): Promise<unknown>;
  recognize(
    image: unknown,
    options?: Record<string, unknown>,
    output?: Record<string, boolean>,
  ): Promise<{ data: TesseractPage }>;
  terminate(): Promise<void>;
}

export interface TesseractModuleLike {
  createWorker(
    langs: string,
    oem: number,
    options: Record<string, unknown>,
    config: Record<string, string>,
  ): Promise<TesseractWorkerLike>;
}

export interface TesseractPaths {
  /** Absolute URL of `worker.min.js`. */
  workerUrl: string;
  /** Absolute URL of the one pinned core. */
  coreUrl: string;
  /** Absolute URL of the directory holding `eng.traineddata`. */
  langPath: string;
}

/** Where each asset sits, given the base URL this build was made for. */
export function tesseractPaths(
  baseUrl: string,
  files: { worker: string; core: string },
): TesseractPaths {
  return {
    workerUrl: new URL(`${OCR_ASSET_DIR}${files.worker}`, baseUrl).href,
    coreUrl: new URL(`${OCR_ASSET_DIR}${files.core}`, baseUrl).href,
    // No trailing file: tesseract.js appends `/eng.traineddata` itself. The trailing
    // slash goes, because it joins with one.
    langPath: new URL(OCR_ASSET_DIR, baseUrl).href.replace(/\/$/, ""),
  };
}

/**
 * The options object handed to `createWorker`. Every entry is load-bearing:
 *
 * - the three paths are the CDN overrides;
 * - `workerBlobURL: false` means the worker is created from a real same-origin URL rather
 *   than from a blob wrapper, so it is a client the service worker controls and its own
 *   requests for the core and the model are served from Cache Storage when offline;
 * - `gzip: false` because the model is shipped uncompressed and named `eng.traineddata`;
 * - `cacheMethod: "none"` because Cache Storage already holds these bytes, verified, and a
 *   second copy in IndexedDB would be 4.5 MB of the user's storage for nothing.
 */
export function tesseractOptions(paths: TesseractPaths): Record<string, unknown> {
  return {
    workerPath: paths.workerUrl,
    corePath: paths.coreUrl,
    langPath: paths.langPath,
    workerBlobURL: false,
    gzip: false,
    cacheMethod: "none",
  };
}

/** A worker, loaded and initialized against the pinned assets. */
export async function createTesseractWorker(
  module: TesseractModuleLike,
  paths: TesseractPaths,
): Promise<TesseractWorkerLike> {
  const worker = await module.createWorker(OCR_LANG, OCR_OEM, tesseractOptions(paths), {
    ...OCR_INIT_CONFIG,
  });
  await worker.setParameters({ ...OCR_PARAMS });
  return worker;
}

/** What `recognize` is asked for: the text, and the per-character confidences §5 marks. */
export const RECOGNIZE_OUTPUT: Readonly<Record<string, boolean>> = { text: true, blocks: true };

/** Only characters the whitelist allows survive; tesseract's own spacing does not. */
function keepable(char: string): boolean {
  return OCR_CHAR_WHITELIST.includes(char);
}

function meanConfidence(chars: readonly OcrChar[]): number {
  return chars.reduce((total, char) => total + char.confidence, 0) / chars.length;
}

/**
 * The page tesseract returned, as one line and the tokens it is made of.
 *
 * §5's marks need a confidence per character, so the symbols are walked rather than the
 * text: `data.text` alone cannot say which position was the doubtful one.
 *
 * The tokens are the engine's own words, and they are the "pattern step" §5 asks for. A
 * crop box wide enough for a gloved hand to aim with catches the tokens either side of the
 * paint code, and no rule written over characters can say which of `2722`, `35`, `0925`
 * and `WA8555` is a paint code — §5 measured that a cross-manufacturer regex fabricates.
 * A word boundary is not a guess about which token is the answer; it is where the engine
 * saw a gap, and the person holding the phone picks (N2).
 *
 * A token with nothing the whitelist allows is dropped rather than kept as an empty
 * string, which would otherwise be an option on screen with no characters in it.
 */
export function toOcrLine(page: TesseractPage): OcrLine {
  const tokens: OcrToken[] = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          const chars: OcrChar[] = [];
          for (const symbol of word.symbols ?? []) {
            if (keepable(symbol.text)) {
              chars.push({ char: symbol.text, confidence: symbol.confidence });
            }
          }
          if (chars.length === 0) continue;
          tokens.push({
            text: chars.map((char) => char.char).join(""),
            confidence: meanConfidence(chars),
            chars,
          });
        }
      }
    }
  }
  return {
    text: tokens.map((token) => token.text).join(" "),
    confidence: page.confidence,
    chars: tokens.flatMap((token) => token.chars),
    tokens,
  };
}

/**
 * The module object, whichever way the bundle chose to expose itself.
 *
 * `dist/tesseract.esm.min.js` has exactly one export and it is the default one — a CommonJS
 * bundle wrapped for ESM — so reaching for `createWorker` on the namespace gets
 * `undefined`, and the e2e run is the only place that shows up. Both shapes are accepted
 * and neither is assumed.
 */
export function resolveTesseractModule(imported: unknown): TesseractModuleLike {
  const namespace = imported as { default?: unknown } | null;
  for (const candidate of [namespace?.default, namespace]) {
    const module = candidate as TesseractModuleLike | undefined;
    if (typeof module?.createWorker === "function") return module;
  }
  throw new OcrError("engine_failed", "the OCR runtime exports no createWorker");
}

/**
 * The one line that cannot be exercised in a node test: a dynamic import of a URL that
 * only exists in a built app. The e2e suite runs it against the real asset.
 */
export async function importTesseract(url: string): Promise<TesseractModuleLike> {
  return resolveTesseractModule(await import(/* @vite-ignore */ url));
}
