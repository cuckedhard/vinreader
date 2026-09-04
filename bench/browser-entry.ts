/**
 * §13.4 scan-robustness bench — the decoder under test, **inside a browser**.
 *
 * This module is bundled by `browser-decode.ts` and evaluated in a Chromium page. It is the
 * app's decode path and not an imitation of it: `BrowserMultiFormatReader` from
 * `@zxing/browser`, built from `buildScanHints()` (§4.6, the same function `useScanner`
 * calls), reading a `<canvas>` through `HTMLCanvasElementLuminanceSource` →
 * `HybridBinarizer` → `MultiFormatReader.decodeWithState`. `decodeFromCanvas` is the exact
 * call the scan loop makes on every frame (`BrowserCodeReader.prototype.scan` →
 * `drawImageOnCanvas` → `decodeFromCanvas`).
 *
 * **Why this file exists** (finding B2). The bench used to decode a PNG in node through
 * `RGBLuminanceSource`, which is a different luminance source, a different
 * `isRotateSupported()` answer — `RGBLuminanceSource` says no, so `OneDReader`'s
 * `TRY_HARDER` 90° retry never fired — and `MultiFormatReader.decode(bitmap, hints)` rather
 * than `decodeWithState`. Every number the bench produced was therefore a statement about a
 * decoder the product does not ship. It is the same corpus and the same seeds; only the
 * instrument changed.
 *
 * **What is still not a camera frame.** The app draws a `<video>` element; this draws a
 * decoded PNG. A real frame has been through the sensor, the ISP and YUV 4:2:0 — see the
 * `yuv` path below, which models the colour half of that, and `browser-decode.ts` for what
 * remains uncovered.
 *
 * No node API is available here. Keep this file DOM-only.
 */

import { BrowserMultiFormatReader } from "@zxing/browser";
import {
  BarcodeFormat,
  ChecksumException,
  FormatException,
  NotFoundException,
} from "@zxing/library";
import { buildScanHints, stripAimIdentifier } from "../src/lib/vin/symbologies";

/** The two in-page paths. `rgb` (the old node path) lives in `decode.ts`. */
export type BrowserDecodePath = "canvas" | "yuv";

export interface BrowserDecodeResult {
  /** The label's own bytes: the decode, less the §4.6 AIM identifier. `null` on a no-read. */
  text: string | null;
  /** Whether `stripAimIdentifier` (§4.6) removed anything — counted, never assumed. */
  aimStripped: boolean;
  /** ZXing's `BarcodeFormat` name. `null` on a no-read. */
  format: string | null;
  /** Wall time of `decodeFromCanvas` in milliseconds. Excludes the PNG→canvas step. */
  ms: number;
  /** A fault the runner must surface rather than score as a miss. `null` when there was none. */
  fault: string | null;
}

/** One frame read off the fake camera, tagged with the marker it carried. */
export interface CameraDecodeResult extends BrowserDecodeResult {
  /** The frame index the marker encoded, so a decode is attributable to a known image. */
  index: number;
  /** The video track's resolution, so a silent rescale cannot pass unnoticed. */
  width: number;
  height: number;
}

export interface CameraProbeRequest {
  /** How many distinct frames the y4m carries. */
  count: number;
  /** Give up after this many milliseconds rather than hanging the probe. */
  timeoutMs: number;
  /** Marker geometry — see `readMarker`. */
  cell: number;
  bits: number;
}

export interface BenchBridge {
  decode(frames: readonly string[], path: BrowserDecodePath): Promise<BrowserDecodeResult[]>;
  camera(request: CameraProbeRequest): Promise<CameraDecodeResult[]>;
}

declare global {
  interface Window {
    /** Installed by this bundle; called by `browser-decode.ts` through `page.evaluate`. */
    __vinBench?: BenchBridge;
  }
}

/**
 * One reader for the page, built the way `useScanner` builds its own — `buildScanHints()`
 * and nothing else. The constructor's second argument only sets the scan loop's two timers
 * (`delayBetweenScanAttempts` / `delayBetweenScanSuccess`), and this file never runs that
 * loop: it schedules its own frames. Restating those milliseconds here would put a copy of
 * a constant in a second place for no effect (§7 item 5).
 */
const READER = new BrowserMultiFormatReader(buildScanHints());

/** ZXing's own names for "this frame carries no symbol I can read". */
const NO_READ_KINDS: ReadonlySet<string> = new Set([
  NotFoundException.kind,
  ChecksumException.kind,
  FormatException.kind,
]);

/**
 * A reader exception is an answer, not a fault. `getKind()` is checked ahead of `instanceof`
 * for the reason `decode.ts` documents at length: `@zxing/library` is ES5-downlevelled over
 * `ts-custom-error` and its prototype chain does not survive that, so `instanceof` on the
 * base class is already false inside the library itself.
 */
function isNoRead(error: unknown): boolean {
  const kind = (error as { getKind?: () => string } | null)?.getKind;
  if (typeof kind === "function") return NO_READ_KINDS.has(kind.call(error));
  return (
    error instanceof NotFoundException ||
    error instanceof ChecksumException ||
    error instanceof FormatException
  );
}

/** base64 → bytes. The frames arrive over CDP, which carries JSON and not binary. */
function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * One canvas for the page, resized only when the frame's size changes — which is what the
 * app does: `createCaptureCanvas` sizes itself once from the video and every later frame is
 * drawn over the last. Resizing clears the canvas, and not resizing does not, but every draw
 * here covers the whole canvas with an opaque image, so no frame can inherit a pixel from
 * the one before it either way. Skipping the reallocation matters for the camera probe,
 * which redraws a 1920×1080 frame every few milliseconds.
 */
let canvas: HTMLCanvasElement | null = null;

function context(width: number, height: number): CanvasRenderingContext2D {
  if (canvas === null) canvas = document.createElement("canvas");
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  // `willReadFrequently` is what `@zxing/browser` asks for on both the capture canvas and
  // inside `HTMLCanvasElementLuminanceSource`; it selects a software-backed canvas, so the
  // pixels this bench decodes are the pixels the app's binarizer would see.
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null) throw new Error("bench: no 2d context");
  return ctx;
}

/**
 * BT.601 studio-swing, the matrix Chromium applies to a `C420` YUV4MPEG2 stream that carries
 * no `XCOLORRANGE` — which is what `bench/make-fake-camera.py` writes and what the fake
 * camera hands the video element.
 *
 * Modelled rather than measured, deliberately and with a stated bound: driving a real camera
 * costs one Chromium launch per frame (see `browser-decode.ts`). What this reproduces is the
 * colour half of a capture — the 16..235 luma quantisation and the 2×2 chroma decimation.
 * What it does not reproduce is the sensor, the ISP, rolling shutter, or any resampling
 * between the capture size and the video element.
 */
function toI420AndBack(image: ImageData): void {
  const { width, height, data } = image;
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  const luma = new Uint8ClampedArray(width * height);
  const cb = new Float64Array(cw * ch);
  const cr = new Float64Array(cw * ch);
  const count = new Uint32Array(cw * ch);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const r = data[at];
      const g = data[at + 1];
      const b = data[at + 2];
      luma[y * width + x] = (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16) & 0xff;
      const c = Math.floor(y / 2) * cw + Math.floor(x / 2);
      cb[c] += ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
      cr[c] += ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
      count[c] += 1;
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const c = Math.floor(y / 2) * cw + Math.floor(x / 2);
      const n = count[c];
      const C = luma[y * width + x] - 16;
      const D = Math.round(cb[c] / n) - 128;
      const E = Math.round(cr[c] / n) - 128;
      const at = (y * width + x) * 4;
      data[at] = (298 * C + 409 * E + 128) >> 8;
      data[at + 1] = (298 * C - 100 * D - 208 * E + 128) >> 8;
      data[at + 2] = (298 * C + 516 * D + 128) >> 8;
      // Alpha is left alone: the frame is opaque and `HTMLCanvasElementLuminanceSource`
      // reads a zero alpha as white.
    }
  }
}

async function decodeOne(base64: string, path: BrowserDecodePath): Promise<BrowserDecodeResult> {
  const bitmap = await createImageBitmap(new Blob([decodeBase64(base64)], { type: "image/png" }));
  const ctx = context(bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  if (path === "yuv") {
    const image = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
    toI420AndBack(image);
    ctx.putImageData(image, 0, 0);
  }

  const started = performance.now();
  try {
    // The app's per-frame call, verbatim.
    const result = READER.decodeFromCanvas(ctx.canvas as HTMLCanvasElement);
    const ms = performance.now() - started;
    const format = result.getBarcodeFormat();
    const raw = result.getText();
    const text = stripAimIdentifier(raw, format);
    return { text, aimStripped: text !== raw, format: BarcodeFormat[format], ms, fault: null };
  } catch (error) {
    const ms = performance.now() - started;
    if (isNoRead(error)) return { text: null, aimStripped: false, format: null, ms, fault: null };
    const named = error as { name?: string; message?: string };
    return {
      text: null,
      aimStripped: false,
      format: null,
      ms,
      fault: `${named?.name ?? "Error"}: ${named?.message ?? String(error)}`,
    };
  }
}

/**
 * Read the frame index a padded frame carries in its top-left corner: one always-black sync
 * cell, then `bits` cells, LSB first, black for 1. Sampled at each cell's centre, thresholded
 * at mid-grey.
 *
 * A marker rather than a timestamp because the fake camera's frame clock and the page's are
 * different clocks: the only reliable way to say *which* image a decode came from is to put
 * the answer in the image.
 */
function readMarker(ctx: CanvasRenderingContext2D, cell: number, bits: number): number {
  const strip = ctx.getImageData(0, 0, cell * (bits + 1), cell);
  const at = (index: number): number => {
    const x = index * cell + (cell >> 1);
    const y = cell >> 1;
    return strip.data[(y * strip.width + x) * 4];
  };
  if (at(0) >= 128) return -1; // no sync cell: this frame is not one of ours
  let value = 0;
  for (let bit = 0; bit < bits; bit += 1) {
    if (at(bit + 1) < 128) value |= 1 << bit;
  }
  return value;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * The closest this bench gets to the app: Chromium's own capture pipeline, a real
 * `<video>` element, and `drawImage(video)` — the app's `drawImageOnCanvas` — feeding the
 * same `decodeFromCanvas`. The frames come from `--use-file-for-fake-video-capture`, so they
 * have been through I420 and back exactly as a camera's would be.
 *
 * It reads whatever frame the camera happens to be showing, keeps the first decode for each
 * marker index, and stops when it has one of each or runs out of time. The camera loops the
 * file, so a frame missed on one pass comes round again.
 */
async function cameraProbe(request: CameraProbeRequest): Promise<CameraDecodeResult[]> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();

  const seen = new Map<number, CameraDecodeResult>();
  const deadline = performance.now() + request.timeoutMs;
  while (seen.size < request.count && performance.now() < deadline) {
    await sleep(8);
    if (video.videoWidth === 0) continue;
    const ctx = context(video.videoWidth, video.videoHeight);
    // `BrowserCodeReader.drawImageOnCanvas`, which is what the scan loop calls, verbatim.
    ctx.drawImage(video, 0, 0);
    const index = readMarker(ctx, request.cell, request.bits);
    if (index < 0 || index >= request.count || seen.has(index)) continue;
    const started = performance.now();
    try {
      const result = READER.decodeFromCanvas(ctx.canvas as HTMLCanvasElement);
      const format = result.getBarcodeFormat();
      const raw = result.getText();
      const text = stripAimIdentifier(raw, format);
      seen.set(index, {
        index,
        width: video.videoWidth,
        height: video.videoHeight,
        text,
        aimStripped: text !== raw,
        format: BarcodeFormat[format],
        ms: performance.now() - started,
        fault: null,
      });
    } catch (error) {
      const ms = performance.now() - started;
      const base = { index, width: video.videoWidth, height: video.videoHeight, ms };
      if (isNoRead(error)) {
        seen.set(index, { ...base, text: null, aimStripped: false, format: null, fault: null });
      } else {
        const named = error as { name?: string; message?: string };
        seen.set(index, {
          ...base,
          text: null,
          aimStripped: false,
          format: null,
          fault: `${named?.name ?? "Error"}: ${named?.message ?? String(error)}`,
        });
      }
    }
  }
  for (const track of stream.getTracks()) track.stop();
  return [...seen.values()].sort((a, b) => a.index - b.index);
}

window.__vinBench = {
  /**
   * A batch, decoded one frame at a time. Sequential on purpose: ZXing's decode is
   * synchronous on this page's only thread, so concurrency inside a page buys nothing and
   * would only interleave the timings. `browser-decode.ts` gets its parallelism from
   * running several pages.
   */
  async decode(frames: readonly string[], path: BrowserDecodePath) {
    const out: BrowserDecodeResult[] = [];
    for (const frame of frames) out.push(await decodeOne(frame, path));
    return out;
  },

  camera: cameraProbe,
};
