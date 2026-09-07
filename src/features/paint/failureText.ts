/**
 * One sentence per §4-recorded refusal, and which refusals share one.
 *
 * A rule, not a list of strings, so it lives in a pure sibling for the reason
 * `proposalView.ts` gives about itself: `vitest.config.ts` pins `environment: "node"`, so a
 * rule inside a React file cannot be unit-tested in this repo at all, and most of these
 * reasons cannot be reached from a browser test either — `dictionary_present` is a property
 * of the bytes a build shipped and `busy` needs two recognitions at once.
 *
 * Two rules decide the wording, both of them §6.4's:
 *
 *   · **Say what happened, never a cause the client cannot see (N2).** `support.ts` detects
 *     the *absence* of a capability, not a setting: an old browser, a stripped embedded
 *     WebView and a Lockdown-Mode iPhone hand it the same signal. So the five capability
 *     refusals share one sentence that says what is true of all five, and none of them
 *     names WebAssembly, SIMD or a preference the user is supposed to go and change.
 *   · **Offer a retry only where a retry can change the answer.** A refusal about the bytes
 *     this build shipped is the same refusal on the next tap and on every tap after it, so
 *     it does not ask for one. The route that is always left is the typed field, which is on
 *     screen in every state.
 *
 * None of them blames the user.
 */
import type { OcrFailure } from "../../lib/ocr/types";

/**
 * The five capability refusals. `support.ts` orders them so the reason recorded is the
 * first thing actually missing, which is what a bug report needs; what the user is told is
 * the one fact that holds for every one of them.
 */
export const CANNOT_RUN = "This browser can't run the reader. Type the code instead.";

/** §4: iOS caps fast WASM memories at 3 per web-content process, so the two never overlap. */
export const SCANNER_LIVE = "The camera is busy with a barcode scan. Go back, then try again.";

export const ABORTED = "The read stopped when the screen went away. Try again.";

export const DOWNLOAD_FAILED =
  "The reader didn't download. Check your signal and try again, or type the code.";

/** Bytes that are not the bytes this build shipped: a transfer fault, and retryable. */
export const CORRUPT_ASSET = "The reader didn't download cleanly. Try again, or type the code.";

/**
 * `dictionary_present` is not that (§3, N2). The digest has already matched by the time the
 * dictionary check runs, so these *are* the bytes this build shipped and the next download
 * fetches them again. Nothing the user does clears it, so nothing here asks them to try.
 */
export const UNUSABLE_BUILD = "The reader isn't usable in this build. Type the code instead.";

export const ENGINE_FAILED = "The reader stopped. Try again, or type the code.";

/** `engine.ts`: one worker, one instance. The reader has not stopped — it is running. */
export const BUSY = "A read is already running. Wait for it to finish, or type the code.";

export function failureText(reason: OcrFailure): string {
  switch (reason) {
    case "no_wasm":
    case "no_simd":
    case "no_worker":
    case "no_canvas":
    case "no_cache":
      return CANNOT_RUN;
    case "scanner_live":
      return SCANNER_LIVE;
    case "aborted":
      return ABORTED;
    case "download_failed":
      return DOWNLOAD_FAILED;
    case "corrupt_asset":
      return CORRUPT_ASSET;
    case "dictionary_present":
      return UNUSABLE_BUILD;
    case "engine_failed":
      return ENGINE_FAILED;
    case "busy":
      return BUSY;
  }
}
