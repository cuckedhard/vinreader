/**
 * The paint-code capture mode's own camera, and the read that runs on it.
 *
 * A **separate** camera session, on a screen of its own. Not a second decoder on the ZXing
 * stream: that loop already decodes every frame and §13.4 measures what it costs, so
 * sharing it degrades VIN scanning, which is the app's core function (N1/P1). The
 * interlock runs the other way too — `browserOcrEngine` refuses while the barcode scanner
 * holds a camera (`scannerLive.ts`).
 *
 * What this file does not do is decide anything. The states are `session.ts`, the vote is
 * `vote.ts`, the crop geometry is `cropBox.ts` and the pipeline is `preprocess.ts`, all of
 * them pure and tested in node, because a rule inside a React file cannot be unit-tested
 * in this repo at all (`vitest.config.ts` pins `environment: "node"`, with no jsdom). This
 * is the wiring between them and a camera.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RefObject } from "react";
import { appBaseUrl } from "../../app/appBase";
import { browserCropReader, browserOcrEngine } from "../../lib/ocr/browser";
import { OCR_VOTE_FRAMES } from "../../lib/ocr/constants";
import { displayedToSourceRect } from "../../lib/ocr/cropBox";
import {
  initialPaintCaptureState,
  paintCaptureReducer,
  type PaintCaptureState,
} from "../../lib/ocr/session";
import { OcrError, type OcrFailure } from "../../lib/ocr/types";

/**
 * Resolution is the single biggest accuracy driver in S5 addendum §3, and iOS has no torch
 * — WebKit ignores the constraint — so the frame is asked to be as large as the device
 * will give and the rest is leaned on stills, the crop (which is the digital zoom) and
 * voting. Deliberately its own constant rather than §6.3's: that one describes the barcode
 * scanner, and the two screens must be free to diverge without dragging each other.
 */
const PAINT_VIDEO_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
};

export interface PaintCaptureApi {
  state: PaintCaptureState;
  /** True once the camera failed to start. The typed escape is the route, never a dead end. */
  cameraFailed: boolean;
  /** True once the stream reports a frame size, which is what the crop is measured against. */
  cameraReady: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  previewRef: RefObject<HTMLDivElement | null>;
  boxRef: RefObject<HTMLDivElement | null>;
  /** An object URL for the last crop the engine read, or null. Memory only (§12). */
  cropUrl: string | null;
  read: () => void;
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function isPageHidden(): boolean {
  return document.visibilityState === "hidden";
}

function failureOf(error: unknown): OcrFailure {
  return error instanceof OcrError ? error.reason : "engine_failed";
}

export function usePaintCapture(): PaintCaptureApi {
  const engine = useMemo(() => browserOcrEngine(appBaseUrl()), []);
  const reader = useMemo(() => browserCropReader(), []);
  const [state, dispatch] = useReducer(
    paintCaptureReducer,
    engine.support(),
    initialPaintCaptureState,
  );
  const [cameraFailed, setCameraFailed] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cropUrl, setCropUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const cropUrlRef = useRef<string | null>(null);
  const pageHidden = useSyncExternalStore(subscribeVisibility, isPageHidden);

  const supported = state.kind !== "unsupported";

  /**
   * One camera, for as long as this screen is the thing on screen.
   *
   * It is stopped on the way out whatever happened: a track left running is a camera light
   * left on. On a device that cannot run the engine at all it is never turned on in the
   * first place — there is nothing to aim at there, the route is the typed field, and
   * asking for a camera to feed a preview nobody can read from is a permission prompt spent
   * on nothing.
   *
   * A hidden page drops it too. §4: backgrounding is cancellation, iOS gives about seven
   * seconds of grace and then suspends. `engine.ts` already aborts the read on the way out;
   * this is the other half, and it comes back when the screen does — which is what §6.3
   * already does with the scan screen's camera.
   */
  useEffect(() => {
    if (!supported || pageHidden) return;
    // Copied once: this element is mounted for the life of the effect, and the cleanup
    // must stop the tracks it attached rather than whatever the ref points at later.
    const video = videoRef.current;
    let cancelled = false;
    let stream: MediaStream | null = null;

    async function start() {
      if (navigator.mediaDevices === undefined) {
        setCameraFailed(true);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia(PAINT_VIDEO_CONSTRAINTS);
      } catch {
        // Every reason lands in the same place, because the remedy is the same one: the
        // typed field below, which is on screen in every state (P7).
        if (!cancelled) setCameraFailed(true);
        return;
      }
      if (cancelled) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      if (video !== null) {
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        void video.play().catch(() => {
          // An interrupted play is not a capture failure; the frames still arrive.
        });
      }
    }

    void start();
    return () => {
      cancelled = true;
      if (stream !== null) for (const track of stream.getTracks()) track.stop();
      if (video !== null) video.srcObject = null;
    };
  }, [supported, pageHidden]);

  // The engine, the worker and the object URL all outlive a render, and none of them
  // outlives the screen. Backgrounding is already cancellation inside `engine.ts` (§4).
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      reader.dispose();
      void engine.dispose();
      if (cropUrlRef.current !== null) URL.revokeObjectURL(cropUrlRef.current);
    };
  }, [engine, reader]);

  const showCrop = useCallback((blob: Blob) => {
    if (cropUrlRef.current !== null) URL.revokeObjectURL(cropUrlRef.current);
    const url = URL.createObjectURL(blob);
    cropUrlRef.current = url;
    setCropUrl(url);
  }, []);

  /**
   * The rectangle the user aligned, in frame pixels — read off the boxes the browser laid
   * out, never off the fractions that asked for them. A `min-height` winning a cascade
   * would otherwise crop a band nobody aimed with, and that is the one failure nothing
   * downstream can catch (N2).
   */
  const sourceRect = useCallback(() => {
    const video = videoRef.current;
    const preview = previewRef.current;
    const box = boxRef.current;
    if (video === null || preview === null || box === null) return null;
    const previewBox = preview.getBoundingClientRect();
    const aimed = box.getBoundingClientRect();
    return displayedToSourceRect(
      {
        left: aimed.left - previewBox.left,
        top: aimed.top - previewBox.top,
        width: aimed.width,
        height: aimed.height,
      },
      { width: previewBox.width, height: previewBox.height },
      { width: video.videoWidth, height: video.videoHeight },
    );
  }, []);

  const read = useCallback(() => {
    // The reducer refuses a second `start` too; this refuses a second *loop*, which is the
    // half a pure reducer cannot see.
    if (runningRef.current) return;
    if (engine.support() !== "ready") return;
    runningRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "start" });

    void (async () => {
      try {
        for (let frame = 0; frame < OCR_VOTE_FRAMES; frame += 1) {
          if (controller.signal.aborted) throw new OcrError("aborted");
          const rect = sourceRect();
          const video = videoRef.current;
          if (rect === null || video === null) {
            throw new OcrError("engine_failed", "the camera has no frame to crop yet");
          }
          // A still, not a frame off a decode loop. `createImageBitmap` decodes off the
          // main thread and the bitmap is transferred to the preprocessing worker, so the
          // preview keeps painting while the crop is prepared.
          const bitmap = await createImageBitmap(video);
          const crop = await reader.read(bitmap, rect);
          const line = await engine.recognize(crop.blob, {
            signal: controller.signal,
            onProgress: (progress) => dispatch({ type: "progress", progress }),
          });
          // §5: the pixels the engine read, shown above the characters it read them as.
          showCrop(crop.blob);
          dispatch({ type: "read", line });
        }
      } catch (error) {
        dispatch({ type: "failed", reason: failureOf(error) });
      } finally {
        runningRef.current = false;
      }
    })();
  }, [engine, reader, showCrop, sourceRect]);

  const onMetadata = useCallback(() => {
    const video = videoRef.current;
    setCameraReady(video !== null && video.videoWidth > 0 && video.videoHeight > 0);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    video.addEventListener("loadedmetadata", onMetadata);
    // The stream may already be attached and sized by the time this runs.
    onMetadata();
    return () => video.removeEventListener("loadedmetadata", onMetadata);
  }, [onMetadata]);

  return { state, cameraFailed, cameraReady, videoRef, previewRef, boxRef, cropUrl, read };
}
