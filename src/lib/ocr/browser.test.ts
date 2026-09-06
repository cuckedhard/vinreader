/**
 * The wiring, where getting it wrong is silent.
 *
 * `engine.ts` made `isScannerLive` a *required* dependency in pass 1 so that pass 2 could
 * not forget it — but a required dependency is still satisfied by `() => false`, and that
 * lie is invisible from every other test in the gate: OCR would simply run, on a phone
 * already decoding every frame through ZXing (N1/P1), holding a second camera and a WASM
 * memory iOS caps at three per web-content process. So the wiring is asserted through the
 * real store rather than by reading the file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserOcrEngine, ocrPaths } from "./browser";
import { acquireScanner } from "./scannerLive";

const BASE = "https://phone.example/vinreader/";

/** Everything `support.ts` asks for, so the run reaches the interlock rather than stopping short. */
function ableBrowser(): void {
  vi.stubGlobal("Worker", class {});
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("caches", {});
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browserOcrEngine", () => {
  it("is ready on a browser that has the four things support.ts asks for", () => {
    ableBrowser();
    expect(browserOcrEngine(BASE).support()).toBe("ready");
  });

  it("refuses to read while the barcode scanner holds a camera", async () => {
    ableBrowser();
    const engine = browserOcrEngine(BASE);
    const release = acquireScanner();
    try {
      // Not "the dependency was passed" — the real store, taken by the real scan screen's
      // own acquire, refusing a real run before a byte is downloaded.
      await expect(engine.recognize("frame")).rejects.toMatchObject({ reason: "scanner_live" });
    } finally {
      release();
    }
  });

  it("says no_canvas on a browser with no OffscreenCanvas for the worker to draw on", () => {
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("caches", {});
    expect(browserOcrEngine(BASE).support()).toBe("no_canvas");
  });
});

describe("ocrPaths", () => {
  it("points every asset at this origin, under the base this build was made for", () => {
    const paths = ocrPaths(BASE);
    for (const url of [paths.workerUrl, paths.coreUrl, paths.langPath]) {
      expect(url.startsWith(`${BASE}ocr`)).toBe(true);
    }
    // The three tesseract.js defaults this replaces all point at a CDN (N3, and offline).
    expect(JSON.stringify(paths)).not.toContain("jsdelivr");
  });
});
