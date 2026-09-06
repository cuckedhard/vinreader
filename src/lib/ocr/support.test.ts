/**
 * The gate in front of a 4.5 MB download.
 *
 * Two of the four answers are the fleet, not defensive noise: iOS Lockdown Mode disables
 * WebAssembly outright (§1), and this build pins the SIMD core (§4), so a device without
 * either has to be told before it spends the bytes rather than after.
 */
import { describe, expect, it } from "vitest";
import { detectSimd, ocrSupport, readOcrCapabilities, SIMD_PROBE_MODULE } from "./support";
import type { OcrCapabilities } from "./support";

const ABLE: OcrCapabilities = { wasm: true, simd: true, worker: true, cacheStorage: true };

describe("detectSimd", () => {
  it("accepts the probe on an engine that has SIMD, which this one does", () => {
    expect(detectSimd({ WebAssembly, Worker: null, caches: null })).toBe(true);
  });

  it("is the real thing: the probe module validates, and a corrupted one does not", () => {
    const probe = new Uint8Array(SIMD_PROBE_MODULE);
    expect(WebAssembly.validate(probe)).toBe(true);
    const broken = new Uint8Array(SIMD_PROBE_MODULE);
    // The `i8x16.splat` opcode, replaced by an unreachable byte.
    broken[broken.length - 4] = 0x00;
    expect(WebAssembly.validate(broken)).toBe(false);
  });

  it("says no when an engine rejects the probe, and when there is no engine", () => {
    expect(detectSimd({ WebAssembly: { validate: () => false } })).toBe(false);
    expect(detectSimd({})).toBe(false);
  });

  it("says no when validate throws rather than letting the throw escape", () => {
    expect(
      detectSimd({
        WebAssembly: {
          validate: () => {
            throw new Error("no");
          },
        },
      }),
    ).toBe(false);
  });
});

describe("readOcrCapabilities", () => {
  it("reads what it was handed, and nothing it was not", () => {
    expect(readOcrCapabilities({ WebAssembly, Worker: class {}, caches: {} })).toEqual(ABLE);
    expect(readOcrCapabilities({})).toEqual({
      wasm: false,
      simd: false,
      worker: false,
      cacheStorage: false,
    });
  });
});

describe("ocrSupport", () => {
  it("is ready only when all four are present", () => {
    expect(ocrSupport(ABLE)).toBe("ready");
  });

  it("names the first missing capability, WebAssembly before SIMD", () => {
    expect(ocrSupport({ ...ABLE, wasm: false, simd: false })).toBe("no_wasm");
    expect(ocrSupport({ ...ABLE, simd: false })).toBe("no_simd");
    expect(ocrSupport({ ...ABLE, worker: false })).toBe("no_worker");
    expect(ocrSupport({ ...ABLE, cacheStorage: false })).toBe("no_cache");
  });
});
