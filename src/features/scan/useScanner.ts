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
import { CONFIRM_WINDOW_MS, scanReducer, startingScanMachine } from "./scanMachine";
import type { ScanAction, ScanMachineState } from "./scanMachine";

export interface TorchApi {
  available: boolean;
  on: boolean;
  toggle: () => void;
}

/** §9-S1's tap-to-refocus. `available` is false wherever the platform reports no mode. */
export interface FocusApi {
  available: boolean;
  refocus: () => void;
}

export interface ScannerApi {
  state: ScanMachineState;
  videoRef: RefObject<HTMLVideoElement | null>;
  torch: TorchApi;
  focus: FocusApi;
  retry: () => void;
  rescan: () => void;
  accept: (vin: string) => void;
}

/**
 * Neither capability is in the standard MediaTrack types. §6.1 gates the torch button on
 * `torch`; §9-S1 gates tap-to-refocus on `focusMode`, which is a list of the modes the
 * track will accept rather than a flag.
 */
interface TrackCapabilities extends MediaTrackCapabilities {
  torch?: boolean;
  focusMode?: string[];
}

interface TorchConstraintSet extends MediaTrackConstraintSet {
  torch: boolean;
}

interface FocusConstraintSet extends MediaTrackConstraintSet {
  focusMode: string;
}

/**
 * The modes a tap may ask for, in the order a tap means. `single-shot` re-runs autofocus
 * once, which is the gesture itself; `continuous` restarts the running loop on the scene the
 * user just aimed at; `manual` pins focus where it is, the most a device offering nothing
 * else can do with a tap. §9-S1 wants the control "only if the platform supports focusMode
 * constraints (otherwise nothing)", and §11 makes that absence the rule rather than the
 * exception: Android Chrome reports some subset of these, iOS Safari reports no key at all.
 */
const FOCUS_MODES = ["single-shot", "continuous", "manual"] as const;

/**
 * The mode a tap would apply, or `null` where the platform offers none — which is also what
 * a track with no `getCapabilities` at all reports. Pure, so the §11 degradation is testable
 * without a camera. `null` means no control is rendered, never a dead one (P7).
 */
export function pickFocusMode(capabilities: TrackCapabilities | undefined): string | null {
  const modes = capabilities?.focusMode;
  // A browser that reports the key as something other than a list is telling us nothing we
  // can act on, and `includes` on it would throw inside the camera-start path.
  if (!Array.isArray(modes)) return null;
  return FOCUS_MODES.find((mode) => modes.includes(mode)) ?? null;
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

/**
 * §6.3's agreement window, waited out. The reducer decides *whether* a standing candidate
 * has run out of window (it compares the stamp this timer carries); this arms the ask, and
 * keeps asking until the answer is yes.
 *
 * Why it re-arms rather than firing once. The scan screen runs on two clocks: `setTimeout`
 * counts monotonic milliseconds, while both the sighting's stamp and this tick's come from
 * `Date.now()`, which follows the wall clock. A backward correction of 1 ms to
 * `CONFIRM_WINDOW_MS + 1` between the sighting and the firing shortens the *measured* gap
 * without moving the firing, so the tick lands back inside the window — the reducer keeps
 * the candidate, correctly, and returns the identical machine to say so. React then bails
 * out of the re-render, this effect never re-runs, its cleanup never runs, and a one-shot
 * timer has spent the only tick that was ever going to be sent: Z9's exact symptom returns,
 * "Reading… hold steady." over a live preview, until another decode, a hide, a dead track or
 * a navigation happens to take it down. So the tick that did not lapse anything schedules
 * the next one from the clock as it now reads.
 *
 * It terminates on its own: it re-arms only while the deadline is still ahead, and every
 * re-arm has a strictly positive delay, so a spent window arms nothing (a zero-delay chain
 * would spin on the main thread the decode loop is sharing). The reducer stays pure — no
 * clock is read there and no constant is restated here (§7 item 5); the deadline is the same
 * arithmetic the first arming already used.
 *
 * It also closes the narrow case the Z9 ledger entry recorded as surviving: an engine that
 * clamps `Date.now()` (Firefox with `resistFingerprinting`, to 100 ms) reads even an on-time
 * tick as inside the window. A one-shot timer gave up there; this one waits out the
 * millisecond the clamped clock says is left and asks again until it moves.
 */
export function armLapseTimer(
  candidateAtMs: number,
  dispatch: (action: ScanAction) => void,
): () => void {
  // One millisecond past the window, because §6.3's bound is inclusive: a tick landing on
  // it is still inside it.
  const deadline = candidateAtMs + CONFIRM_WINDOW_MS + 1;
  let timer = 0;
  function arm(delay: number): void {
    timer = window.setTimeout(() => {
      dispatch({ type: "tick", atMs: Date.now() });
      // What is left of the window *by the wall clock*. At or past zero the tick just sent
      // was at or past the deadline, so it lapsed the candidate (or there was none) and
      // there is nothing further to wait for; above zero the clock moved back under us and
      // the remainder still has to be waited out.
      const remaining = deadline - Date.now();
      if (remaining > 0) arm(remaining);
    }, delay);
  }
  // Clamped at zero for a deadline that is already behind us.
  arm(Math.max(deadline - Date.now(), 0));
  // Clears whichever timer is currently armed, first or twentieth.
  return () => window.clearTimeout(timer);
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
  const [focusMode, setFocusMode] = useState<string | null>(null);
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
    // The next track answers the capability question again; until it does there is nothing
    // to focus, so the tap target goes with the stream (§11).
    setFocusMode(null);
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
              ? (track.getCapabilities() as TrackCapabilities)
              : undefined;
          // §6.1: the button appears when the capabilities *report* torch, which is the
          // value and not the key — Chrome publishes `torch: false` for a camera with no
          // lamp. iOS Safari omits the key entirely. Neither gets a dead control (P7).
          setTorchAvailable(capabilities?.torch === true);
          // §9-S1's tap-to-refocus, gated on the same one call: a platform that names no
          // focus mode gets no tap target at all rather than a tap that does nothing.
          setFocusMode(pickFocusMode(capabilities));
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

  const refocus = useCallback(() => {
    const track = trackRef.current;
    if (track === null || focusMode === null) return;
    const focusSet: FocusConstraintSet = { focusMode };
    const constraints: MediaTrackConstraints = { advanced: [focusSet] };
    async function apply(target: MediaStreamTrack) {
      try {
        await target.applyConstraints(constraints);
      } catch {
        // §11: focus constraints are inconsistent across browsers and degrade to nothing,
        // never to an error. A refused tap leaves the preview exactly as it was, and the
        // user's remedy — move the phone, tap again — is the same either way.
      }
    }
    void apply(track);
  }, [focusMode]);

  const focus = useMemo<FocusApi>(
    () => ({ available: focusMode !== null, refocus }),
    [focusMode, refocus],
  );

  // §6.3 gives agreement 1.5 s and nothing reported it running out (Z9). The deadline is
  // read off the sighting the machine is holding, so a second frame — which replaces that
  // sighting and re-runs this effect — restarts the window rather than inheriting it.
  const candidateAtMs = machine.state.kind === "candidate" ? machine.state.sighting.atMs : null;

  useEffect(() => {
    // A disabled scanner dispatches nothing, and a hidden tab has already had its candidate
    // dropped by §6.3's `hidden`, so there is nothing left to lapse in either case.
    if (!enabled || pageHidden || candidateAtMs === null) return;
    // Cleared when the candidate changes or goes, when the tab hides, and on unmount: a
    // timer that outlived the screen would dispatch into a machine nobody is showing.
    return armLapseTimer(candidateAtMs, dispatch);
  }, [enabled, pageHidden, candidateAtMs]);

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

  return { state: machine.state, videoRef, torch, focus, retry, rescan, accept };
}
