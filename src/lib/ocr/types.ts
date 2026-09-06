/**
 * What the OCR engine can return, and every way it can refuse.
 *
 * A refusal is always a named reason, never a swallowed exception (P7): the screen that
 * asks for OCR has to be able to say which §6.4 sentence applies, and the one thing it may
 * never do is fall back to a value nobody read. N2 — a paint code has no check digit, no
 * grammar and no downstream lookup, so a wrong one is never contradicted by anything.
 */

/** Why OCR is not available, or why a run ended without a proposal. */
export type OcrFailure =
  /** `WebAssembly` is absent. iOS Lockdown Mode disables it outright (§1). */
  | "no_wasm"
  /** No SIMD. The core this build pins is the SIMD one (§4). */
  | "no_simd"
  /** No `Worker`. OCR never shares a thread with the ZXing barcode path (N1/P1). */
  | "no_worker"
  /** No Cache Storage, so the engine could only ever be fetched again (§3). */
  | "no_cache"
  /**
   * No `OffscreenCanvas`. The crop is rectified, greyed and upscaled on a 2D canvas inside
   * a worker (§3's preprocessing order), and a worker has no other canvas to draw on.
   * Costs nothing in practice: WebKit shipped `OffscreenCanvas` and WASM SIMD in the same
   * release, so a device with the core this build pins has this too.
   */
  | "no_canvas"
  /** The camera is live. iOS caps fast WASM memories at 3 per web-content process (§4). */
  | "scanner_live"
  /** The screen went away, or the caller cancelled. Backgrounding is cancellation (§4). */
  | "aborted"
  /** The engine could not be downloaded. */
  | "download_failed"
  /** Downloaded bytes are not the bytes this build shipped. */
  | "corrupt_asset"
  /** The model carries a dictionary, which bends a paint code toward a word (§3, N2). */
  | "dictionary_present"
  /** The engine loaded and then failed while reading. */
  | "engine_failed"
  /** A recognition is already running. One worker, one instance (§4). */
  | "busy";

/** Every refusal, as an error the caller can branch on without parsing a message. */
export class OcrError extends Error {
  readonly reason: OcrFailure;

  constructor(reason: OcrFailure, message?: string) {
    super(message ?? reason);
    this.name = "OcrError";
    this.reason = reason;
  }
}

/** One character the engine read, and how sure it was of that character. */
export interface OcrChar {
  char: string;
  /** 0–100, as tesseract reports it. */
  confidence: number;
}

/**
 * One token the engine segmented out of the crop.
 *
 * This is S5 addendum §5's "pattern step": the crop box is a generous single *line*, so a
 * gloved hand can hit it, and a line on a door-jamb label carries a paint code next to a
 * GVWR figure, a tyre pressure or a date. The step that picks the code out of that line is
 * **not** a cross-manufacturer regex — Ford's two letters and GM's four digits cannot be
 * told apart from those neighbours by any pattern, and §5 records that it fabricates. It
 * is the word segmentation the engine already did, offered to the person holding the phone
 * as §5's equal-weight candidates with nothing preselected (N2).
 */
export interface OcrToken {
  text: string;
  confidence: number;
  chars: OcrChar[];
}

/**
 * One line of proposed text. Never a fact: §5 forbids auto-accepting at any confidence,
 * so this is what a human is shown, not what is stored.
 */
export interface OcrLine {
  /** The whole line, tokens joined by a space. For a log and for a human reading a diff. */
  text: string;
  confidence: number;
  chars: OcrChar[];
  /** The line's tokens, in reading order. What the vote is actually taken over. */
  tokens: OcrToken[];
}

/** Bytes moved so far against bytes the download will move in total. */
export interface OcrProgress {
  /** The file being fetched, or `null` once every file is in the cache. */
  file: string | null;
  loadedBytes: number;
  totalBytes: number;
}
