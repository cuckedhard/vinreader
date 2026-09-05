import type { JSX, RefObject } from "react";
import { checkDigitApplies } from "../../lib/vin/checkDigit";
import type { ScanError } from "../../lib/vin/types";
import { Banner } from "../../ui/Banner";
import type { BannerTone } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { VinDisplay } from "../../ui/VinDisplay";
import type { ScanMachineState } from "./scanMachine";
import type { FocusApi, TorchApi } from "./useScanner";

export interface CameraViewProps {
  state: ScanMachineState;
  videoRef: RefObject<HTMLVideoElement | null>;
  torch: TorchApi;
  /**
   * §9-S1's tap-to-refocus. Required, and deliberately: it was optional, no screen passed
   * it, the default said "unavailable" and the feature was unreachable in the running app
   * (R3-B). The platform gate belongs to `useScanner`, which reports `available: false`
   * wherever no `focusMode` was reported — that is the §11 "otherwise nothing" branch, and
   * it is not the same thing as a caller forgetting the prop.
   */
  focus: FocusApi;
  onRetry: () => void;
  onTypeInstead: () => void;
  /**
   * True once a confirmed read failed to store. The machine cannot know a write outcome,
   * so the screen is told: a success line above a banner saying nothing was written is the
   * screen contradicting itself, which §6.3 forbids and §6.1 makes dangerous — the green
   * line is what gets read at arm's length before walking away from the truck. The
   * check-digit hold is NOT this: `isHeldForCheck` already derives it from the state.
   */
  unsaved?: boolean;
}

/**
 * §6.4 has no line for a stream the machine gave up on (`idle.lost`, and the
 * defensive `stream_lost` branch), so this one is supplied here.
 */
const CAMERA_STOPPED = "Camera stopped. It starts again when this screen is active.";

/** §6.4 has no line for the 1–3 s black frame while iOS opens the camera. Supplied here. */
const STARTING = "Starting camera…";

/**
 * §6.4 has no line for a confirmed read the D03 gate is holding. Supplied here, neutral and
 * never celebratory: §6.3 says success feedback never fires on a mismatch, and §6.1 makes
 * this line the primary feedback. The §6.4 check-digit wording belongs to the banner.
 */
const HELD_FOR_CHECK = "Check this read.";

/**
 * A read that was fine but was not stored. Distinct from HELD_FOR_CHECK: the remedy is not
 * to look at the label again, and §6.1 makes this line the primary feedback, so pointing at
 * the wrong remedy while the banner below points at the right one is worse than silence.
 */
const NOT_SAVED = "Not saved.";

/**
 * §6.4 has no line for §9-S1's tap-to-refocus, which only exists where the platform reports
 * the capability. Supplied here (§0 rule 4), and it names the gesture rather than the
 * machinery: the target is the whole preview, and a tap is the only gesture N5 allows.
 */
const TAP_TO_FOCUS = "Tap to focus";

/**
 * §6.1's aim box: a wide horizontal box (~90% × ~22%) because the target is a 1D barcode,
 * with a `100vmax` spread shadow dimming everything outside it so the aim point survives
 * glare.
 *
 * The stroke is a **pair** — a white core with a black ring immediately inside it — and not
 * one palette colour. This is the only element in the app that sits over *arbitrary live
 * video*, and no single colour contrasts with all of it. Measured the way Z4 measured
 * (WCAG relative luminance), against the scrimmed surround outside the box (0.55 black over
 * video, i.e. 0.45 × video) and against the raw video inside it, at video luminance
 * 255 / 128 / 40, plus the worst case over all 256 levels:
 *
 *   `--accent`, dark theme      2.50 :  6.00 :  9.83   worst  2.50 (video 255)
 *   `--accent`, light theme     1.67 :  1.44 :  2.35   worst  1.00 (video 180 — invisible)
 *   white core vs. surround     4.76 : 11.44 : 18.73   worst  4.76 (video 255)
 *   black ring vs. video       21.00 :  5.32 :  1.42   fades on dark video, where the white
 *   white core vs. video        1.00 :  3.95 : 14.74   core reads that edge instead
 *   white core vs. black ring  21.00 at every level
 *
 * So the outline holds ≥ 4.76:1 against the surround and ≥ 4.61:1 across the inner edge
 * (worst at video 117), against the 3:1 floor for a non-text graphic — §6.1's 7:1 is a
 * body-text floor and this is a graphic. Both strokes are literals rather than tokens, so
 * the dark and light themes render the same box and the same numbers, and a future palette
 * change cannot take the guide box with it. Not decoration: §12 rules out light-theme
 * polish, and snow glare is the case §6.1 is written for.
 */
const GUIDE_BOX =
  "h-[22%] w-[90%] rounded-[var(--radius)] border-2 border-white " +
  "shadow-[inset_0_0_0_2px_#000,0_0_0_100vmax_rgba(0,0,0,0.55)]";

/**
 * §6.6 wants a visible focus ring, and the two controls inside the preview are the only ones
 * in the app whose ring can land on live video. They share this one (R3-U), which is the same
 * idea as `GUIDE_BOX`: a black stroke and a white stroke together, so whichever the background
 * washes out, the other reads. Black sits outermost (0–2 px) and white inside it (2–5 px),
 * because on the tap target it is the *inner* side that faces the scrimmed video.
 *
 * Drawn as an inset `box-shadow` rather than an `outline`, for a reason that is not
 * stylistic: the preview is `overflow-hidden` and the tap target fills its padding box, so
 * any ring drawn *outside* the target — which is what `outline-offset: 2px` does — is clipped
 * away entirely. Inset is the only ring that survives on that control, and `box-shadow` is
 * the only property that can draw one here.
 *
 * That is also how R3-U-b was found. `src/index.css` used to end with an **unlayered**
 * `:focus-visible`, which outranks `@layer utilities` whatever the specificity, so this
 * control's `outline-offset: -3px` was silently replaced by `+2px` and its ring was clipped
 * out of existence — no visible indicator at all. That rule now lives in `@layer base`, so
 * `focus-visible:outline-none` below takes effect and each control shows exactly one
 * indicator (verified in Chromium: `outline-style: none`, `outline-width: 0px`).
 *
 * Measured as `GUIDE_BOX` was, sweeping all 256 video levels rather than three:
 *
 *   tap target, white edge vs. the scrimmed video   4.76 : 11.44 : 18.73 at video 255/128/40,
 *                                                   worst **4.76** (video 255), both themes
 *   torch, on its own `--bg-elev` fill              white 16.96 (dark) · black 19.02 (light),
 *                                                   worst **16.96**, and video never reaches it
 *   white vs. black, inside the ring                21.00 everywhere
 *
 * against the 2.50 (dark) / 1.00 (light, at video 180) the `--accent` ring measures over the
 * same scrim, and WCAG's 3:1 floor for a focus indicator. `focus-visible:outline-none` turns
 * the app-wide ring off for these two controls only, via `--tw-outline-style`, which the
 * width utility reads — so it wins over `Button`'s own outline regardless of rule order.
 */
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_#000,inset_0_0_0_5px_#fff]";

/**
 * Whether a confirmed read is being held back rather than saved (D03). It uses the §4.3
 * predicate the write path uses, so an identifier that carries no check digit at all still
 * reads as a success (D17).
 */
function isHeldForCheck(state: ScanMachineState): boolean {
  return (
    state.kind === "confirmed" &&
    !state.sighting.checkDigitValid &&
    checkDigitApplies(state.sighting.vin)
  );
}

interface Notice {
  tone: BannerTone;
  message: string;
  /** insecure_context cannot be retried, and a dead button is worse than none (P7). */
  retry: boolean;
}

function errorNotice(error: ScanError): Notice {
  switch (error) {
    case "permission_denied":
      return {
        tone: "warn",
        message:
          "Camera is blocked. Allow camera for this site in your browser settings, " +
          "or type the VIN.",
        retry: true,
      };
    case "insecure_context":
      return { tone: "danger", message: "Camera needs a secure (https) connection.", retry: false };
    case "no_camera":
      // §6.4 has no line. Supplied here, and it blames the device, not the user.
      return { tone: "warn", message: "No camera is available on this device.", retry: true };
    case "stream_lost":
      // §6.3 routes a dropped track to idle.lost, so this is unreachable; it
      // reuses the idle.lost copy rather than inventing more.
      return { tone: "warn", message: CAMERA_STOPPED, retry: true };
  }
}

function noticeFor(state: ScanMachineState): Notice | null {
  if (state.kind === "error") return errorNotice(state.error);
  // A stopped camera with only a passive line is a dead end when the screen is
  // already active, so idle.lost carries the same retry route (P7).
  if (state.kind === "idle" && state.lost) {
    return { tone: "warn", message: CAMERA_STOPPED, retry: true };
  }
  return null;
}

/** §6.4, verbatim for streaming, candidate and confirmed. */
function statusFor(state: ScanMachineState, unsaved: boolean): string {
  switch (state.kind) {
    case "requesting":
      return STARTING;
    case "streaming":
      return "Point at the barcode on the door-jamb sticker.";
    case "candidate":
      return "Reading… hold steady.";
    case "confirmed":
      if (isHeldForCheck(state)) return HELD_FOR_CHECK;
      return unsaved ? NOT_SAVED : "Got it ✓";
    case "idle":
    case "error":
      // Handled by the notice, which carries its own alert role.
      return "";
  }
}

function statusToneFor(state: ScanMachineState, unsaved: boolean): string {
  // A held read is a warning, not a success: the success colour next to the mismatch banner
  // is the screen contradicting itself (§6.3).
  if (state.kind === "confirmed") return isHeldForCheck(state) || unsaved ? "text-warn" : "text-ok";
  if (state.kind === "candidate") return "text-accent";
  return "text-fg-muted";
}

/**
 * The camera surface. Presentational only: it renders the §6.3 machine state and
 * reports taps upwards. No stream, no decoding and no timers live here.
 */
export function CameraView({
  state,
  videoRef,
  torch,
  focus,
  onRetry,
  onTypeInstead,
  unsaved = false,
}: CameraViewProps): JSX.Element {
  const notice = noticeFor(state);
  const status = statusFor(state, unsaved);
  const aiming = state.kind === "streaming" || state.kind === "candidate";
  const sighting = state.kind === "candidate" || state.kind === "confirmed" ? state.sighting : null;
  // Whichever route forward exists gets the 56 px primary target (§6.1).
  const typeVariant = notice !== null && !notice.retry ? "primary" : "secondary";
  // §6.3 stops the stream on `confirmed`, and there is no stream at all in the states that
  // carry a notice — `error`, and `idle` after the track dropped. What is left in every one
  // of them is a dead black box ~470 px tall: it pushed the Rescan / Use as-is decision
  // below the fold on `confirmed`, and in the error states it pushed §6.4's own escape
  // routes off the screen (F7). At 320×658 neither Retry nor "Type VIN instead" had a
  // single pixel inside `main` and a tap at their centres landed on the bottom nav, so the
  // fallback out of a dead camera was unreachable because the camera was dead — which N1
  // and P1 forbid. The first `idle` keeps the box: nothing has failed, the request is on
  // its way, and hiding it there would only jump the layout on the way up.
  //
  // Hidden rather than unmounted so `videoRef` still points at this element when Retry or
  // Rescan returns the machine to `streaming`.
  const previewClasses = [
    "relative w-full flex-1 overflow-hidden rounded-[var(--radius)] border border-border bg-black",
    state.kind === "confirmed" || notice !== null ? "hidden" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    // §6.1: "Portrait and landscape both work", and sideways it did not (F11). A phone turned
    // over is short, not small: at 844x390 the portrait column — a 3:4 preview, then the
    // status line, then the buttons — needs 460 px of a 341 px fold, so §6.4's "Type VIN
    // instead" had 0 visible pixels and a tap at its centre landed on the bottom nav while
    // the camera was working perfectly. Nothing can be trimmed to fit: the fixed parts alone
    // (heading, status, button, padding, gaps) are 226 px, which leaves 115 px for a preview.
    // So landscape lays the same two parts out side by side instead, which is where the width
    // went — the row is the idiom R4-I already used on the §9-S3 QR overlay for the same
    // reason. Portrait is untouched, and `landscape:` covers the short desktop window too.
    <div className="flex w-full flex-col gap-4 landscape:flex-row landscape:items-start">
      <div className={previewClasses}>
        {/* 50vh sideways rather than 60: the row's height is the fold minus the heading and
            the padding, and 60vh of a 360 px viewport does not leave the status line room. */}
        <div className="aspect-[3/4] max-h-[60vh] w-full landscape:max-h-[50vh]">
          <video
            ref={videoRef}
            muted
            autoPlay
            // Without playsInline iOS opens the video full screen and the scan is unusable.
            playsInline
            aria-hidden="true"
            className="h-full w-full object-cover"
          />
        </div>

        {aiming ? (
          // §6.1: the aim box must never intercept a tap, so the whole overlay is inert.
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            {/* Shape, scrim and the two-tone stroke are all documented on GUIDE_BOX. */}
            <div className={GUIDE_BOX} />
          </div>
        ) : null}

        {focus.available && aiming ? (
          // §9-S1: tap-to-refocus, and only where the platform reported a focusMode — iOS
          // Safari reports none and gets nothing here (§11). The whole preview is the
          // target, because the tap is aimed at the label the user is already pointing at
          // and §6.1 floors a target at 48 px; it is a plain tap, never a long press or a
          // pinch (N5). It comes after the guide box, which stays inert and takes no tap of
          // its own, and before the torch, which keeps its own.
          <button
            type="button"
            onClick={focus.refocus}
            className={"absolute inset-0 h-full w-full cursor-pointer bg-transparent " + FOCUS_RING}
          >
            {/* Measured, and deliberately left alone. The pill's `--bg-elev` fill against the
                scrimmed video runs 3.56 : 1.48 : 1.10 at video 255/128/40 in the dark theme,
                worst 1.00 at video 63 — so on mid-dark video its *edge* disappears. That is
                not a legibility failure and does not want fixing: the fill is opaque and the
                label rides on it, not on the video, at 15.75:1 dark and 17.41:1 light, well
                over §6.1's 7:1. What vanishes is the outline of a filled block, not the words.
                (Light theme, for the record: 4.31 : 10.37 : 16.97, worst 4.31.) */}
            <span className="absolute bottom-3 left-3 inline-flex min-h-[var(--tap)] items-center rounded-[var(--radius)] border border-border bg-bg-elev px-4 text-base font-bold text-fg">
              {TAP_TO_FOCUS}
            </span>
          </button>
        ) : null}

        {torch.available ? (
          <Button
            variant="secondary"
            onClick={torch.toggle}
            aria-pressed={torch.on}
            className={`absolute right-3 bottom-3 px-4 ${FOCUS_RING}`}
          >
            {torch.on ? "Torch on" : "Torch off"}
          </Button>
        ) : null}
      </div>

      {/* The status line, the notice and the two routes forward, as one part: in portrait
          they stack under the preview exactly as before, and sideways they are the column
          beside it. `min-w-0` so a 17-character VIN at §6.1's 28 px cannot push the row
          wider than the fold. */}
      <div className="flex min-w-0 flex-col gap-4 landscape:flex-1">
        <div
          role="status"
          aria-live="polite"
          className="flex min-h-[var(--tap)] flex-col items-start justify-center gap-2"
        >
          {status === "" ? null : (
            <p className={`text-lg leading-snug font-bold ${statusToneFor(state, unsaved)}`}>
              {status}
            </p>
          )}
          {/* §6.1 floors a VIN display at 28 px on a phone, and the candidate is exactly the
              moment the number is being checked against the sticker at arm's length. */}
          {sighting === null ? null : <VinDisplay vin={sighting.vin} size="lg" />}
        </div>

        {notice === null ? null : <Banner tone={notice.tone} title={notice.message} />}

        {/* The fallback for a destroyed label or a dead camera, so it is never
            hidden behind an error state (P7). */}
        <div className="flex flex-col gap-3">
          {notice !== null && notice.retry ? (
            <Button variant="primary" full onClick={onRetry}>
              Retry
            </Button>
          ) : null}
          <Button variant={typeVariant} full onClick={onTypeInstead}>
            Type VIN instead
          </Button>
        </div>
      </div>
    </div>
  );
}
