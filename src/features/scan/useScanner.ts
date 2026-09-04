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
import { ChecksumException, FormatException, NotFoundException } from "@zxing/library";
import type { Result } from "@zxing/library";
import { isPayloadCarrier } from "../../lib/payload/carrier";
import { extractVin } from "../../lib/vin/extractVin";
import { buildScanHints, toSymbology } from "../../lib/vin/symbologies";
import type { ScanError } from "../../lib/vin/types";
import { cooldownStore } from "./cooldownStore";
import { scanReducer, startingScanMachine } from "./scanMachine";
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

/**
 * How long ZXing waits before the next decode attempt, and after a successful one. The
 * §4.6 hints it goes with are `buildScanHints`, shared with the bench.
 *
 * §9-S1 asks for a confirmed read in about two seconds, and §6.3 gets there only through
 * two agreeing reads inside a 1.5 s window. ZXing defaults both delays to 500 ms — roughly
 * two attempts a second, so three chances in the whole budget and half a second lost to
 * every frame that misses. At 100 ms, plus the decode itself, the confirmation window holds
 * four to six attempts. It is not zero because each decode is synchronous on the main
 * thread: a gap keeps the preview painting and the phone cool, and at 30 fps a shorter one
 * would re-read frames the camera has not replaced yet. §9-S1 permits this tuning inside
 * the slice; it is not a §4 constant.
 */
const SCAN_DELAY_MS = 100;

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

/** ZXing's own names for "this frame carries no symbol I can read". */
const NO_READ_KINDS: ReadonlySet<string> = new Set([
  NotFoundException.kind,
  ChecksumException.kind,
  FormatException.kind,
]);

/**
 * Whether a decode error is the normal negative result rather than a fault. `@zxing/browser`
 * re-queues its decode loop after exactly these three and stops permanently after anything
 * else, so this has to agree with the loop's own reading of the error.
 *
 * Both discriminators are consulted because either can fail on its own: `@zxing/library` is
 * ES5-downlevelled over `ts-custom-error` and its `Exception` prototype chain does not
 * survive that (`MultiFormatReader` logs "non-ReaderException from reader" for every
 * ordinary miss for exactly that reason), while `getKind` is absent from a plain `TypeError`
 * out of the canvas. They need not agree — either witness is enough to ignore the frame,
 * because mistaking a miss for a fault would tear down a scan that is working.
 */
function isNoRead(error: unknown): boolean {
  const getKind = (error as { getKind?: () => string } | null)?.getKind;
  if (typeof getKind === "function" && NO_READ_KINDS.has(getKind.call(error))) return true;
  return (
    error instanceof NotFoundException ||
    error instanceof ChecksumException ||
    error instanceof FormatException
  );
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

export function useScanner(options: {
  enabled: boolean;
  /** §9-S3: a scanned §4.9 carrier is handed over rather than dropped. */
  onCarrier?: (raw: string) => void;
}): ScannerApi {
  const { enabled } = options;
  // handleResult is a stable useCallback and a dependency of the getUserMedia effect,
  // so taking the callback directly would restart the camera on every render. The ref is
  // updated in an effect rather than during render, which React's purity rule forbids.
  const onCarrierRef = useRef(options.onCarrier);
  const { onCarrier } = options;
  useEffect(() => {
    onCarrierRef.current = onCarrier;
  }, [onCarrier]);
  // §6.3's cooldown exists to stop a *return to Scan* double-logging, and that return is a
  // fresh mount: the machine therefore starts from the store that outlives this component
  // rather than from an empty map (A-01).
  const [machine, dispatch] = useReducer(scanReducer, undefined, startingScanMachine);
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

  const handleResult = useCallback((result: Result | undefined, error: unknown) => {
    if (result === undefined) {
      // Not-found, checksum and format failures arrive on nearly every frame and mean only
      // "no symbol here". Anything else has already ended ZXing's decode loop for good,
      // with the camera still live: the preview keeps moving and nothing will ever decode
      // again. The machine leaves `streaming` for the one §4.10 error that says the stream
      // stopped being usable, which the view already renders with a Retry (P7).
      if (error !== undefined && !isNoRead(error)) {
        dispatch({ type: "stream_failed", error: "stream_lost" });
      }
      return;
    }
    const text = result.getText();
    // D14: a §4.9 carrier is one of the app's own handoff payloads, not a VIN, and it decodes
    // identically every frame — so a VIN fabricated out of one would sail through the two-read
    // rule. The carrier test stays ahead of extractVin; S3 routes the hit to Import.
    if (isPayloadCarrier(text)) {
      onCarrierRef.current?.(text);
      return;
    }
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
        const reader = new BrowserMultiFormatReader(buildScanHints(), {
          delayBetweenScanAttempts: SCAN_DELAY_MS,
          delayBetweenScanSuccess: SCAN_DELAY_MS,
        });
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
          // §6.1: the button appears when the capabilities *report* torch, which is the
          // value and not the key — Chrome publishes `torch: false` for a camera with no
          // lamp. iOS Safari omits the key entirely. Neither gets a dead control (P7).
          setTorchAvailable(capabilities?.torch === true);
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
    const atMs = Date.now();
    // The write-through lives here, not in the reducer, which stays pure (P3). Both halves
    // take the same instant so the machine and the store cannot disagree about it.
    cooldownStore.record(vin, atMs);
    dispatch({ type: "accepted", vin, atMs });
  }, []);

  return { state: machine.state, videoRef, torch, retry, rescan, accept };
}
