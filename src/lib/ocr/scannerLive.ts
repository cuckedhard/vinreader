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

/** A camera the barcode scanner holds, and the interlock that goes with it. */
export interface ScannerCamera {
  stream: MediaStream;
  /** Reports the scanner free and stops the tracks. Closing twice does both once. */
  close: () => void;
}

/**
 * The barcode scanner's camera, taken and reported live in the same step.
 *
 * `acquireScanner()` used to be called on its own line inside `useScanner`'s camera
 * effect, next to the `getUserMedia` it was about. That is a guard nothing can hold up:
 * `vitest.config.ts` pins `environment: "node"` with no jsdom, so no unit test in this
 * repo can see a statement inside a React effect, and no e2e can see this one either —
 * `#/scan` and `#/v/:vin/paint` are sibling routes, the scan screen's effect cleanup runs
 * before the capture screen's mounts, and the two are therefore never live at once for a
 * browser to catch a `scanner_live` refusal in. Deleting the line changed nothing any
 * test could observe, on the rule that a scan must never be blocked (N1/P1).
 *
 * Binding the lock to the stream closes both halves. This function is drivable in node
 * with a fake `MediaDevices`, so the acquisition is falsifiable here; and `useScanner`
 * cannot skip it and still have a camera, which every camera test in the e2e suite
 * already fails on. The `MediaDevices` arrives as an argument for the same reason —
 * nothing in this file reaches for a global.
 */
export async function openScannerCamera(
  media: MediaDevices,
  constraints: MediaStreamConstraints,
): Promise<ScannerCamera> {
  // Before the await, not after it: a camera that is being *asked* for is a camera this
  // process is about to hold, and iOS caps fast WASM memories at three per web-content
  // process (S5 addendum §4). A permission prompt is the longest part of this.
  const release = acquireScanner();
  let stream: MediaStream;
  try {
    stream = await media.getUserMedia(constraints);
  } catch (error) {
    // No camera, so no interlock. A refused or missing camera must not leave OCR refusing
    // for the life of the page — the scan screen already tells the user what happened
    // (§6.4), and the paint screen is not the place it gets said again.
    release();
    throw error;
  }
  // Closed once, from wherever gets there first: `useScanner`'s effect cleanup and its own
  // `cancelled` check race each other by design, and both have to be allowed to close.
  let closed = false;
  return {
    stream,
    close: () => {
      if (closed) return;
      closed = true;
      release();
      for (const track of stream.getTracks()) track.stop();
    },
  };
}
