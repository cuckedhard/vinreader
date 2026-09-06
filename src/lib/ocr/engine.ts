/**
 * The engine's lifecycle: one worker, created on demand, dropped the moment the screen
 * goes away.
 *
 * Each rule below is S5 addendum §4, and each is a recorded failure rather than a
 * preference:
 *
 * - **One worker, one instance.** iOS caps fast WASM memories at three per web-content
 *   process, and this app already holds a camera.
 * - **Never while the barcode scanner is live.** `isScannerLive` is a required dependency
 *   rather than an option, so the wiring cannot be forgotten at the call site. N1/P1: a
 *   scan is never blocked, and OCR never shares a thread or a frame loop with ZXing.
 * - **Backgrounding is cancellation.** iOS gives roughly seven seconds of grace and then
 *   suspends. An abort terminates the worker instead of parking it, because a suspended
 *   WASM instance is not a thing to come back to and every intermediate here is
 *   reproducible from the image.
 *
 * What this file will never do is decide anything about the answer. §5, N2: never
 * auto-accept at any confidence. `recognize` returns a proposal; the human is the check.
 */
import type { EnsureOcrAssetsOptions } from "./assets";
import { RECOGNIZE_OUTPUT, toOcrLine, type TesseractWorkerLike } from "./runtime";
import { ocrSupport, type OcrCapabilities, type OcrSupport } from "./support";
import { OcrError, type OcrLine, type OcrProgress } from "./types";

export interface OcrEngineDeps {
  /** What this device can do (`support.ts`). Read per run: capabilities do not change. */
  capabilities: () => OcrCapabilities;
  /** True while the camera is streaming. Required, not optional. */
  isScannerLive: () => boolean;
  /** Downloads and verifies the four assets (`assets.ts`). */
  ensureAssets: (options: EnsureOcrAssetsOptions) => Promise<Uint8Array>;
  /** Spawns the tesseract worker against the pinned assets (`runtime.ts`). */
  createWorker: () => Promise<TesseractWorkerLike>;
  /** Calls back when the document is hidden; returns an unsubscribe. */
  onHidden: (listener: () => void) => () => void;
}

export interface RecognizeOptions {
  signal?: AbortSignal;
  onProgress?: (progress: OcrProgress) => void;
  /** The user-aligned crop box (§5), in image pixels. */
  rectangle?: { left: number; top: number; width: number; height: number };
}

export interface OcrEngine {
  /** Whether this device can run OCR at all, and if not, which sentence to show. */
  support: () => OcrSupport;
  /** Reads one crop. Resolves with a proposal, or rejects with an `OcrError`. */
  recognize: (image: unknown, options?: RecognizeOptions) => Promise<OcrLine>;
  /** Terminates the worker if there is one. Safe to call at any time, more than once. */
  dispose: () => Promise<void>;
}

/**
 * `work`, or a rejection the moment `signal` aborts — whichever happens first.
 *
 * Checking `signal.aborted` between awaits is not enough and the difference is the whole
 * rule: `worker.recognize` on a 3 MB frame does not resolve because the page was hidden,
 * and iOS suspends the process about seven seconds later. Waiting for it is waiting for a
 * promise that will never settle. The worker is terminated by the caller's error path,
 * which is the only way to stop a recognition that has already started.
 *
 * `Promise.race` subscribes to both, so whichever loses is still handled when it settles.
 */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(new OcrError("aborted"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  return Promise.race([work, aborted]);
}

export function createOcrEngine(deps: OcrEngineDeps): OcrEngine {
  let worker: TesseractWorkerLike | null = null;
  let running = false;

  async function dispose(): Promise<void> {
    const current = worker;
    worker = null;
    if (current === null) return;
    // A terminate that throws must not mask the reason the run ended.
    await current.terminate().catch(() => {});
  }

  async function ensureWorker(): Promise<TesseractWorkerLike> {
    if (worker === null) worker = await deps.createWorker();
    return worker;
  }

  function support(): OcrSupport {
    return ocrSupport(deps.capabilities());
  }

  async function recognize(image: unknown, options: RecognizeOptions = {}): Promise<OcrLine> {
    const verdict = support();
    if (verdict !== "ready") throw new OcrError(verdict);
    if (deps.isScannerLive()) throw new OcrError("scanner_live");
    if (running) throw new OcrError("busy");

    running = true;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const stopWatchingVisibility = deps.onHidden(abort);
    options.signal?.addEventListener("abort", abort);

    try {
      // An already-aborted signal fires no `abort` event, so the race would never see it
      // and the download would start for a screen that is already gone.
      if (options.signal?.aborted === true) throw new OcrError("aborted");
      await raceAbort(
        deps.ensureAssets({ signal: controller.signal, onProgress: options.onProgress }),
        controller.signal,
      );
      const instance = await raceAbort(ensureWorker(), controller.signal);
      const rectangle = options.rectangle;
      const result = await raceAbort(
        instance.recognize(image, rectangle === undefined ? {} : { rectangle }, {
          ...RECOGNIZE_OUTPUT,
        }),
        controller.signal,
      );
      return toOcrLine(result.data);
    } catch (error) {
      // Whatever went wrong, a cancelled run says so: the screen is gone and the reason
      // the user would be shown is "cancelled", not whatever the worker managed to throw
      // on its way out.
      if (controller.signal.aborted) {
        await dispose();
        throw new OcrError("aborted");
      }
      if (error instanceof OcrError) throw error;
      // A worker that failed once is not trusted to have failed cleanly (P7).
      await dispose();
      throw new OcrError("engine_failed", String(error));
    } finally {
      options.signal?.removeEventListener("abort", abort);
      stopWatchingVisibility();
      running = false;
    }
  }

  return { support, recognize, dispose };
}

/** Subscribes to `visibilitychange`, firing only when the document becomes hidden. */
export function onDocumentHidden(listener: () => void): () => void {
  const handler = (): void => {
    if (document.visibilityState === "hidden") listener();
  };
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}
