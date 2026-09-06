/**
 * The preprocessing worker, and the conversation with it.
 *
 * Why a worker at all. S5 addendum §3's pipeline runs on a full camera frame — rectify the
 * aligned box out of it, grey it, upscale it — and the main thread is painting a live
 * preview while it does. N1/P1 is the harder rule behind it: OCR never shares a thread or
 * a frame loop with the ZXing barcode path, and the way to be sure of that is for the OCR
 * work to be somewhere ZXing is not. `OffscreenCanvas` is the only 2D surface a worker
 * has, which is why `support.ts` asks for one before the download starts.
 *
 * The frame crosses as an `ImageBitmap`, transferred rather than copied, and comes back as
 * an encoded `Blob` — which is what tesseract.js takes, and which the screen also shows the
 * user as "the pixels the engine read" (§5). Memory only; §12 forbids attaching the photo
 * to anything.
 *
 * `spawn` is an argument so the conversation can be tested without a worker: the requests,
 * the correlation, the rejection and the disposal are all this file's, and none of them
 * needs a browser to be wrong.
 */
import type { Rect } from "./cropBox";
import type { InkBand } from "./preprocess";
import { OcrError } from "./types";

export interface PreprocessRequest {
  id: number;
  frame: unknown;
  rect: Rect;
}

export interface PreprocessResult {
  blob: Blob;
  width: number;
  height: number;
  scale: number;
  band: InkBand;
}

export type PreprocessResponse =
  | ({ id: number; ok: true } & PreprocessResult)
  | { id: number; ok: false; error: string };

export interface WorkerLike {
  postMessage(message: PreprocessRequest, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { data: PreprocessResponse }) => void): void;
  terminate(): void;
}

export interface CropReader {
  /** One frame, cropped to `rect` and prepared. Rejects with an `OcrError`. */
  read(frame: unknown, rect: Rect): Promise<PreprocessResult>;
  /** Ends the worker. Safe at any time, and more than once. */
  dispose(): void;
}

/** Whether a value can be handed across a worker boundary by transfer rather than copy. */
function transferable(frame: unknown): Transferable[] {
  return typeof ImageBitmap !== "undefined" && frame instanceof ImageBitmap ? [frame] : [];
}

export function createCropReader(spawn: () => WorkerLike): CropReader {
  let worker: WorkerLike | null = null;
  let nextId = 1;
  const waiting = new Map<
    number,
    { resolve: (result: PreprocessResult) => void; reject: (error: Error) => void }
  >();

  function ensureWorker(): WorkerLike {
    if (worker !== null) return worker;
    const spawned = spawn();
    spawned.addEventListener("message", (event) => {
      const response = event.data;
      const pending = waiting.get(response.id);
      // A reply to a request nobody is waiting for is a reply to a disposed session.
      if (pending === undefined) return;
      waiting.delete(response.id);
      if (response.ok) pending.resolve(response);
      else pending.reject(new OcrError("engine_failed", response.error));
    });
    worker = spawned;
    return spawned;
  }

  return {
    read(frame, rect) {
      const id = nextId;
      nextId += 1;
      const instance = ensureWorker();
      return new Promise<PreprocessResult>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        instance.postMessage({ id, frame, rect }, transferable(frame));
      });
    },
    dispose() {
      const current = worker;
      worker = null;
      // Everything still in flight belongs to a screen that is gone. Rejected rather than
      // left pending, so no caller is awaiting a promise that can never settle (P7).
      for (const pending of waiting.values()) pending.reject(new OcrError("aborted"));
      waiting.clear();
      current?.terminate();
    },
  };
}
