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

/**
 * The whitelist as the *engine* is given it, which is the one above plus a space.
 *
 * Measured in Chromium against the shipped assets, on a crop reading `PNT WA8555` — the
 * shape §5's crop box actually produces, because a box a gloved hand can aim with catches
 * the token beside the code:
 *
 *   whitelist `A-Z0-9-`     one word `PNTWA8555`, page confidence **0**, and the `W`
 *                           collapses to 15 while its neighbours sit at 98
 *   whitelist `A-Z0-9- `    two words `PNT` and `WA8555`, page confidence **91**, every
 *                           symbol 98–99
 *
 * A space is not a character that can fabricate a paint code; it is the separator, and
 * withholding it tells the engine the gap it can see cannot exist. That costs the word
 * boundaries §5's pattern step is built on *and* it costs accuracy on the glyph next to the
 * gap. So the engine is allowed the space, and `keepable` in `runtime.ts` still keeps only
 * `OCR_CHAR_WHITELIST` — which is what stops a stray mark becoming a character in a
 * proposal (§3's 96.1% was measured on that set).
 */
export const OCR_WHITELIST_PARAM = `${OCR_CHAR_WHITELIST} `;

/** Set after `initialize`, per recognition. */
export const OCR_PARAMS: Readonly<Record<string, string>> = {
  tessedit_char_whitelist: OCR_WHITELIST_PARAM,
  tessedit_pageseg_mode: OCR_PAGE_SEG_MODE,
};

/**
 * The crop box, as a share of the preview (`cropBox.ts` for why it exists at all).
 *
 * Wide, because a paint code sits on a line of other tokens and the user needs slack to
 * put the line inside it; one line tall, because the box is what stops a GVWR row being
 * read as a paint code. §6.1 floors a target at 48 px and the box is aimed rather than
 * tapped, but it is aimed by a gloved hand in the cold, so the rendered height is floored
 * at `--tap` in CSS as well and the fraction below is only the nominal.
 *
 * Deliberately not §6.1's ~90% × 22% barcode guide: [SB-3] measured a band of that shape
 * taking `data_matrix` from 100% clean to 0%. Different target, different box.
 */
export const PAINT_BOX_WIDTH_FRACTION = 0.88;
export const PAINT_BOX_HEIGHT_FRACTION = 0.14;

/**
 * The glyph height the crop is upscaled to, in pixels.
 *
 * S5 addendum §3: resolution is the single biggest accuracy driver in every study found,
 * and tesseract's LSTM models want roughly 20–30 px of x-height. Every character a paint
 * code can carry is a capital or a digit (`OCR_CHAR_WHITELIST`), so x-height and cap
 * height are the same measurement here. 26 is the middle of the band.
 *
 * §13.7: there is no corpus of real door-jamb stickers, so this is transferred from
 * licence plates and container codes like every other figure in the addendum. It is not a
 * §4 constant and it is not measured on this task.
 */
export const OCR_TARGET_GLYPH_PX = 26;

/** Never upscale past this. Past 4x a bicubic resample is inventing edges, not resolving them. */
export const OCR_MAX_UPSCALE = 4;

/**
 * The ceiling on the image handed to the engine. A 1920-wide crop upscaled 4x is 60 MP of
 * RGBA, which is the OOM §4 caps `MAXIMUM_MEMORY` to avoid, arriving from the other side.
 */
export const OCR_MAX_CROP_PIXELS = 4_000_000;

/**
 * What share of the crop's height a glyph is assumed to be when the ink band cannot be
 * measured — a crop with no contrast in it, or one that is ink from edge to edge.
 *
 * Only a fallback: `measureInkBand` measures the real thing whenever the crop has a line
 * in it, which is the case the box exists to produce.
 */
export const OCR_DEFAULT_GLYPH_FRACTION = 0.35;

/**
 * The ink-band measurement's three thresholds.
 *
 * `MIN_CONTRAST` is the deviation from the background level below which a crop is
 * declared featureless rather than measured: 32 of 255 is a very flat sticker in very bad
 * light, and guessing a band out of noise would scale the image by whatever the noise
 * happened to be. `LEVEL` is the share of the largest deviation present at which a pixel
 * counts as ink, so the measurement follows the crop's own contrast instead of a fixed
 * grey. `ROW_SHARE` is the share of the busiest row's ink a row needs to still count as
 * part of the same line, which is what lets a band end at a descender rather than at the
 * next row of the sticker.
 */
export const OCR_INK_MIN_CONTRAST = 32;
export const OCR_INK_LEVEL = 0.5;
export const OCR_INK_ROW_SHARE = 0.25;

/** A "band" taller than this share of the crop is not a line of text; the fallback applies. */
export const OCR_INK_BAND_MAX_SHARE = 0.9;

/**
 * How many frames a proposal is voted over (S5 addendum §5).
 *
 * Confidence-weighted majority bought 66.7% → 81% on licence plates, and it is why the
 * flow reads several stills rather than the first one that arrives. What it buys is a
 * better default string and **never** the right to skip the human: an OCR confusion
 * (`B/8`, `0/O/D/Q`, `1/I/L`, `5/S`, `2/Z`, `6/G`) comes from the glyph's shape and is
 * identical on every frame of the same sticker in the same light, so agreement across
 * frames is not evidence the way §6.3's two-read rule is for a barcode (N2).
 *
 * Five rather than ten: each frame is a full recognition, the user is holding a phone
 * still while they run, and iOS suspends a backgrounded page after about seven seconds.
 */
export const OCR_VOTE_FRAMES = 5;

/**
 * Marking, and the honesty threshold under it.
 *
 * §5: only the two lowest-confidence positions are ever marked, because marking
 * everything marks nothing — and a position is only marked at all if it is genuinely
 * doubtful, which is what `OCR_MARK_BELOW` decides. `OCR_LOW_CONFIDENCE` is the line under
 * which the screen stops implying the read is good and says what would actually help.
 */
export const OCR_MARKED_MAX = 2;
export const OCR_MARK_BELOW = 80;
export const OCR_LOW_CONFIDENCE = 70;

/** §5 caps the alternatives at three, none of them preselected. */
export const OCR_CANDIDATES_MAX = 3;
