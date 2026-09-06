/**
 * The interlock between the two camera paths.
 *
 * If this reports "free" while ZXing is streaming, OCR starts a second frame loop on a
 * phone that is already decoding every frame — N1/P1, and the reason `engine.ts` makes
 * `isScannerLive` a required dependency rather than an option.
 */
import { describe, expect, it } from "vitest";
import { acquireScanner, isScannerLive } from "./scannerLive";

describe("scannerLive", () => {
  it("is free until something takes it, and free again after", () => {
    expect(isScannerLive()).toBe(false);
    const release = acquireScanner();
    expect(isScannerLive()).toBe(true);
    release();
    expect(isScannerLive()).toBe(false);
  });

  it("stays live while a second session overlaps the first", () => {
    // The scan screen remounting: the next stream is acquired before the last is released.
    const first = acquireScanner();
    const second = acquireScanner();
    first();
    expect(isScannerLive()).toBe(true);
    second();
    expect(isScannerLive()).toBe(false);
  });

  it("counts a double release once, so a stray cleanup cannot report a live camera free", () => {
    const release = acquireScanner();
    const other = acquireScanner();
    release();
    release();
    release();
    expect(isScannerLive()).toBe(true);
    other();
    expect(isScannerLive()).toBe(false);
  });
});
