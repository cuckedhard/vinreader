/**
 * Every setting the OCR engine is pinned to, in one place (§7 item 5).
 *
 * These are not §4 constants — §4 was amended once for S5, for `pc` in the payload codec,
 * and nothing here touches it. They are S5 addendum §3 and §4's measurements and platform
 * constraints, each of which is a recorded failure rather than a preference.
 */
import { WASM_PAGE_BYTES } from "./wasmMemory";

/**
 * Cache Storage bucket for the lazily fetched engine. Versioned: a rebuild of the assets
 * changes their digests, and the old bytes should be droppable by name.
 *
 * The service worker's runtime route for `ocr/` names this same bucket, so a warm-up
 * driven from the page and a request made by the worker land in and read from one cache.
 */
export const OCR_CACHE_NAME = "vin-relay-ocr-v1";

/** Where the assets sit, relative to the app's base URL. Never precached (§3's landmine). */
export const OCR_ASSET_DIR = "ocr/";

/**
 * The URLs the service worker serves from `OCR_CACHE_NAME`, cache-first.
 *
 * Both Vite configs hand this to workbox, so the route and the URLs `assets.ts` builds
 * cannot drift apart (§7 item 5). Anchored on `/ocr/` rather than on the site root,
 * because a Pages deployment serves the app from `/vinreader/`; ending at a single path
 * segment, because `ocr/` has no subdirectories and the shell's own `assets/` must not
 * match.
 *
 * This is the whole offline story for the engine. Nothing precaches it, so a request that
 * this pattern does not match is a request that fails with the network gone.
 */
export const OCR_ASSET_ROUTE = /\/ocr\/[^/]+$/;

/**
 * §4: WebKit reserves a declared maximum up front, so emscripten's 2 GiB default is the
 * documented cause of an OOM *at instantiation* rather than at use. 256 MB is the cap.
 */
export const OCR_MAX_MEMORY_BYTES = 256 * 1024 * 1024;
export const OCR_MAX_MEMORY_PAGES = OCR_MAX_MEMORY_BYTES / WASM_PAGE_BYTES;

/** The one language. Katashiki is out of scope, and a katashiki would be Latin anyway. */
export const OCR_LANG = "eng";

/** `OEM.LSTM_ONLY`. The core ships no legacy engine, and the model carries no legacy data. */
export const OCR_OEM = 1;

/**
 * `PSM.SINGLE_LINE`. §5 makes the capture a user-aligned crop box that is one generous
 * line, which is the mode for it; §3 measured tesseract's PSM 3 default returning
 * *completely empty text* on 4 of 10 realistic full-label images, so the default is not an
 * option even as a fallback.
 */
export const OCR_PAGE_SEG_MODE = "7";

/**
 * §3: 96.1% exact match was measured with an `A-Z0-9-` whitelist. Every paint code shape
 * in the fleet is inside it — Toyota `1F7`, Honda `NH-731P`, Ford `UG`, VW `LC9X`,
 * GM `WA8555` — and a character outside it is noise from the sticker around the code.
 */
export const OCR_CHAR_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-";

/**
 * Passed as tesseract's config file at `initialize`, which is the only time these can be
 * set: they are `*_INIT_MEMBER` parameters and `SetVariable` after the fact is ignored.
 *
 * The shipped model carries no dictionary at all (`traineddata.ts`), so this is the second
 * of two locks on the same door. §3's reason is N2's: a dictionary bends `WA8555` toward a
 * word and returns it confidently wrong, and nothing downstream of a paint code can
 * contradict a wrong one.
 */
export const OCR_INIT_CONFIG: Readonly<Record<string, string>> = {
  load_system_dawg: "false",
  load_freq_dawg: "false",
};

/** Set after `initialize`, per recognition. */
export const OCR_PARAMS: Readonly<Record<string, string>> = {
  tessedit_char_whitelist: OCR_CHAR_WHITELIST,
  tessedit_pageseg_mode: OCR_PAGE_SEG_MODE,
};
