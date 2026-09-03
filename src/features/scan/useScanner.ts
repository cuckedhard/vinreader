/**
 * The effectful half of the scanner: camera acquisition, ZXing decoding, visibility and
 * torch. Every decision belongs to `scanMachine` (§6.3); this file only reports what the
 * hardware did and applies what the machine asked for.
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
import { BrowserMultiFormatReader } from "@zxing/browser";
import type { IScannerControls } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import type { Result } from "@zxing/library";
import { isPayloadCarrier } from "../../lib/payload/carrier";
import { extractVin } from "../../lib/vin/extractVin";
import type { ScanError, Symbology } from "../../lib/vin/types";
import { initialScanMachine, scanReducer } from "./scanMachine";
import type { ScanMachineState } from "./scanMachine";

export interface TorchApi {
  available: boolean;
  on: boolean;
  toggle: () => void;
}

export interface ScannerApi {
  state: ScanMachineState;
  videoRef: RefObject<HTMLVideoElement | null>;
  torch: TorchApi;
  retry: () => void;
  rescan: () => void;
  accept: (vin: string) => void;
}

/** `torch` is absent from the standard MediaTrack types; §6.1 gates the button on it. */
interface TorchCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
}

interface TorchConstraintSet extends MediaTrackConstraintSet {
  torch: boolean;
}

/** §6.3, verbatim. */
const VIDEO_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
};

/** §4.6: these four formats in this priority order, `TRY_HARDER`, nothing else. */
function buildHints(): Map<DecodeHintType, unknown> {
  const hints = new Map<DecodeHintType, unknown>();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.CODE_39,
    BarcodeFormat.CODE_128,
    BarcodeFormat.DATA_MATRIX,
    BarcodeFormat.QR_CODE,
  ]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  return hints;
}

/** §4.6 → §4.10. Anything else means the hints leaked and the result is dropped. */
function toSymbology(format: BarcodeFormat): Symbology | null {
  switch (format) {
    case BarcodeFormat.CODE_39:
      return "code_39";
    case BarcodeFormat.CODE_128:
      return "code_128";
    case BarcodeFormat.DATA_MATRIX:
      return "data_matrix";
    case BarcodeFormat.QR_CODE:
      return "qr_code";
    default:
      return null;
  }
}

function toScanError(error: unknown): ScanError {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "permission_denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "no_camera";
    default:
      // NotReadableError (camera held by another app), AbortError and anything unknown land
      // here: §4.10 has no member for a camera that exists but will not open, and from where
      // the user stands it is unavailable either way.
      return "no_camera";
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function isPageHidden(): boolean {
  return document.visibilityState === "hidden";
}

export function useScanner(options: { enabled: boolean }): ScannerApi {
  const { enabled } = options;
  const [machine, dispatch] = useReducer(scanReducer, initialScanMachine);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const pageHidden = useSyncExternalStore(subscribeVisibility, isPageHidden);

  const handleTrackEnded = useCallback(() => {
    dispatch({ type: "track_ended" });
  }, []);

  const release = useCallback(() => {
    // Detach first: ZXing's stop() disposes the stream, and our own teardown must not read
    // back as the camera dying under the user.
    trackRef.current?.removeEventListener("ended", handleTrackEnded);
    trackRef.current = null;
    controlsRef.current?.stop();
    controlsRef.current = null;
    if (streamRef.current !== null) stopTracks(streamRef.current);
    streamRef.current = null;
    const video = videoRef.current;
    if (video !== null) video.srcObject = null;
    setTorchAvailable(false);
    setTorchOn(false);
  }, [handleTrackEnded]);

  const handleResult = useCallback((result: Result | undefined) => {
    // ZXing reports not-found on nearly every frame through the callback's error argument;
    // that is the normal case, so nothing here inspects or logs it.
    if (result === undefined) return;
    const text = result.getText();
    // D14: a §4.9 carrier is one of the app's own handoff payloads, not a VIN, and it decodes
    // identically every frame — so a VIN fabricated out of one would sail through the two-read
    // rule. S1 drops it; S3 routes it to the Import screen instead.
    if (isPayloadCarrier(text)) return;
    const symbology = toSymbology(result.getBarcodeFormat());
    if (symbology === null) return;
    const extraction = extractVin(text);
    if (extraction === null) return;
    dispatch({ type: "decoded", sighting: { ...extraction, symbology, atMs: Date.now() } });
  }, []);

  const kind = machine.state.kind;
  // The camera stays live across requesting → streaming → candidate, so a confirmed decode
  // and a hidden tab are the only things that drop it mid-scan.
  const wantsCamera =
    enabled &&
    !pageHidden &&
    (kind === "requesting" || kind === "streaming" || kind === "candidate");

  useEffect(() => {
    // A disabled scanner dispatches nothing (the Scan screen turns it off while the user is
    // typing); re-enabling restarts the machine from the top.
    if (!enabled) return;
    dispatch({ type: "mount", secureContext: window.isSecureContext });
  }, [enabled]);

  useEffect(() => {
    // A disabled scanner reports nothing, so the machine's hidden clock cannot start while
    // the user is typing and then expire into a stream_lost they never saw (§6.3).
    if (!enabled) return;
    function onVisibilityChange() {
      if (isPageHidden()) {
        dispatch({ type: "hidden", atMs: Date.now() });
      } else {
        dispatch({ type: "visible", atMs: Date.now(), secureContext: window.isSecureContext });
      }
    }
    return subscribeVisibility(onVisibilityChange);
  }, [enabled]);

  useEffect(() => {
    if (!wantsCamera) return;
    let cancelled = false;

    async function start() {
      if (navigator.mediaDevices === undefined) {
        dispatch({ type: "stream_failed", error: "no_camera" });
        return;
      }
      let stream: MediaStream;
      try {
        // §6.3: an insecure context never reaches here, so no permission prompt can appear.
        stream = await navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS);
      } catch (error) {
        if (!cancelled) dispatch({ type: "stream_failed", error: toScanError(error) });
        return;
      }
      if (cancelled) {
        stopTracks(stream);
        return;
      }
      try {
        const reader = new BrowserMultiFormatReader(buildHints());
        // The element is read only now: the render that put the machine into `requesting` is
        // what mounts it, and that render lands while getUserMedia is still awaiting.
        const controls = await reader.decodeFromStream(
          stream,
          videoRef.current ?? undefined,
          handleResult,
        );
        if (cancelled) {
          controls.stop();
          stopTracks(stream);
          return;
        }
        controlsRef.current = controls;
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0] ?? null;
        trackRef.current = track;
        if (track !== null) {
          track.addEventListener("ended", handleTrackEnded);
          const capabilities =
            typeof track.getCapabilities === "function"
              ? (track.getCapabilities() as TorchCapabilities)
              : undefined;
          // §6.1: no capability, no button — iOS Safari must not show a dead control.
          setTorchAvailable(capabilities !== undefined && "torch" in capabilities);
        }
        dispatch({ type: "stream_started" });
      } catch (error) {
        stopTracks(stream);
        if (!cancelled) dispatch({ type: "stream_failed", error: toScanError(error) });
      }
    }

    void start();
    return () => {
      cancelled = true;
      release();
    };
  }, [wantsCamera, handleResult, handleTrackEnded, release]);

  useEffect(() => {
    // The preview element can mount with the render that reports `streaming`, by which point
    // ZXing has attached the stream to an element of its own. Re-attaching is a no-op when it
    // is the same element and rescues the preview when it is not; decoding is unaffected either
    // way, since ZXing reads whichever element it attached.
    const video = videoRef.current;
    const stream = streamRef.current;
    if (video === null || stream === null || video.srcObject === stream) return;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    void video.play().catch(() => {
      // An interrupted or refused play is not a scan failure.
    });
  }, [kind]);

  const toggle = useCallback(() => {
    const track = trackRef.current;
    if (track === null) return;
    const next = !torchOn;
    const torchSet: TorchConstraintSet = { torch: next };
    const constraints: MediaTrackConstraints = { advanced: [torchSet] };
    async function apply(target: MediaStreamTrack) {
      try {
        await target.applyConstraints(constraints);
        setTorchOn(next);
      } catch {
        // A refused constraint leaves the flag alone: the button must never claim a light
        // that is not lit.
      }
    }
    void apply(track);
  }, [torchOn]);

  const torch = useMemo<TorchApi>(
    () => ({ available: torchAvailable, on: torchOn, toggle }),
    [torchAvailable, torchOn, toggle],
  );

  const retry = useCallback(() => {
    dispatch({ type: "retry", secureContext: window.isSecureContext });
  }, []);

  const rescan = useCallback(() => {
    dispatch({ type: "rescan" });
  }, []);

  const accept = useCallback((vin: string) => {
    dispatch({ type: "accepted", vin, atMs: Date.now() });
  }, []);

  return { state: machine.state, videoRef, torch, retry, rescan, accept };
}
