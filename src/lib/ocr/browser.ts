/**
 * The engine and the preprocessor, wired to this browser.
 *
 * Every dependency `engine.ts` and `preprocessClient.ts` take as an argument is a global
 * here, which is exactly why they are gathered into one file instead of being reached for
 * from a component. Nothing in it decides anything: the rules are in `session.ts`,
 * `vote.ts` and `engine.ts`, and this is the plumbing under them.
 *
 * N3, and the offline half of it: the four asset URLs are all this origin's, the three
 * tesseract.js CDN defaults are overridden in `runtime.ts`, and the service worker serves
 * `ocr/` from Cache Storage. Nothing here can reach a third party.
 */
import { browserOcrAssetDeps, ensureOcrAssets, ocrAssetUrl } from "./assets";
import { OCR_ASSETS } from "./assets.generated";
import { createOcrEngine, onDocumentHidden, type OcrEngine } from "./engine";
import { createCropReader, type CropReader, type WorkerLike } from "./preprocessClient";
import { createTesseractWorker, importTesseract, tesseractPaths } from "./runtime";
import { isScannerLive } from "./scannerLive";
import { readOcrCapabilities, type OcrEnvironment } from "./support";

/** The pinned worker and core, under whatever base this build was made for. */
export function ocrPaths(baseUrl: string) {
  return tesseractPaths(baseUrl, {
    worker: OCR_ASSETS.worker.file,
    core: OCR_ASSETS.core.file,
  });
}

export function browserOcrEngine(baseUrl: string): OcrEngine {
  return createOcrEngine({
    capabilities: () => readOcrCapabilities(globalThis as OcrEnvironment),
    // N1/P1: not a lambda returning false. The real interlock, so a capture screen opened
    // while the scan screen still holds a camera refuses rather than starting a second
    // reader on a phone that is already decoding every frame.
    isScannerLive,
    ensureAssets: (options) => ensureOcrAssets(baseUrl, browserOcrAssetDeps(), options),
    createWorker: async () =>
      createTesseractWorker(
        await importTesseract(ocrAssetUrl(baseUrl, OCR_ASSETS.runtime.file)),
        ocrPaths(baseUrl),
      ),
    onHidden: onDocumentHidden,
  });
}

/**
 * The preprocessing worker, as a real same-origin module worker.
 *
 * `new URL(..., import.meta.url)` is what tells Vite to emit it as its own chunk rather
 * than inlining it into a blob: a blob worker is not a client the service worker controls,
 * and this one is small and precached with the rest of the shell (it holds no WASM and no
 * model — that is the other worker, the one §4 caps at one instance).
 */
export function spawnPreprocessWorker(): WorkerLike {
  return new Worker(new URL("./preprocess.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as WorkerLike;
}

export function browserCropReader(): CropReader {
  return createCropReader(spawnPreprocessWorker);
}
