/**
 * Whether the ZXing barcode scanner is holding a camera right now.
 *
 * N1/P1 and S5 addendum §4: OCR never shares a thread or a frame loop with the barcode
 * path, and it never runs while that path is live — ZXing already decodes every frame and
 * §13.4 measures what that costs, so a second reader on the same stream degrades VIN
 * scanning, which is the app's core function. iOS caps fast WASM memories at three per
 * web-content process, and this app already holds a camera.
 *
 * `engine.ts` takes `isScannerLive` as a *required* dependency so the wiring cannot be
 * forgotten at a call site. This is the thing it is wired to. It lives in `src/lib/ocr/`
 * rather than in `src/features/scan/` so the dependency runs feature → lib and never back.
 *
 * A count rather than a flag: the scan screen can be mounting its next stream while the
 * last one tears down, and a bare boolean would report "free" in the gap.
 */
let holders = 0;

/**
 * Marks a camera session as live until the returned release is called. Releasing twice
 * releases once: a double cleanup must not report the scanner free while it is streaming.
 */
export function acquireScanner(): () => void {
  holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
  };
}

export function isScannerLive(): boolean {
  return holders > 0;
}
