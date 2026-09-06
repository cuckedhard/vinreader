/**
 * Whether this device can run the engine at all, decided before 4.5 MB is downloaded.
 *
 * Three of the four answers are real fleet cases rather than defensive noise. **iOS
 * Lockdown Mode disables WebAssembly outright** (§1), which is why manual entry stays
 * load-bearing however well layer 2 works. The core this build pins is the SIMD one, and
 * a device without SIMD would download it and fail at instantiation. And a `Worker` is not
 * optional: N1/P1 says OCR never shares a thread or a frame loop with the ZXing path.
 *
 * Pure: capabilities in, a verdict out. `readOcrCapabilities` is the only part that looks
 * at anything, and what it looks at is passed to it.
 */
import type { OcrFailure } from "./types";

export interface OcrCapabilities {
  wasm: boolean;
  simd: boolean;
  worker: boolean;
  cacheStorage: boolean;
}

export type OcrSupport =
  "ready" | Extract<OcrFailure, "no_wasm" | "no_simd" | "no_worker" | "no_cache">;

/**
 * The smallest module that uses a SIMD instruction: one function returning `v128`, whose
 * body is `i32.const 0; i8x16.splat; i32x4.all_true`. An engine without SIMD rejects it at
 * validation, which costs nothing and needs no instantiation.
 */
export const SIMD_PROBE_MODULE: readonly number[] = [
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, 0x03,
  0x02, 0x01, 0x00, 0x0a, 0x0a, 0x01, 0x08, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x62, 0x0b,
];

/** What the running environment offers. Everything it reads is handed to it. */
export interface OcrEnvironment {
  WebAssembly?: { validate(bytes: BufferSource): boolean } | undefined;
  Worker?: unknown;
  caches?: unknown;
}

export function detectSimd(env: OcrEnvironment): boolean {
  const wasm = env.WebAssembly;
  if (wasm === undefined) return false;
  try {
    return wasm.validate(new Uint8Array(SIMD_PROBE_MODULE));
  } catch {
    // A `validate` that throws is not a SIMD engine; it is not an engine at all.
    return false;
  }
}

export function readOcrCapabilities(env: OcrEnvironment): OcrCapabilities {
  return {
    wasm: env.WebAssembly !== undefined,
    simd: detectSimd(env),
    worker: env.Worker !== undefined,
    cacheStorage: env.caches !== undefined,
  };
}

/**
 * The first missing capability, in the order the user should hear about it: no
 * WebAssembly at all before no SIMD, because they are different sentences.
 */
export function ocrSupport(capabilities: OcrCapabilities): OcrSupport {
  if (!capabilities.wasm) return "no_wasm";
  if (!capabilities.simd) return "no_simd";
  if (!capabilities.worker) return "no_worker";
  if (!capabilities.cacheStorage) return "no_cache";
  return "ready";
}
