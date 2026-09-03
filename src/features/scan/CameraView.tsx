import type { JSX, RefObject } from "react";
import type { ScanError } from "../../lib/vin/types";
import { Banner } from "../../ui/Banner";
import type { BannerTone } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { VinDisplay } from "../../ui/VinDisplay";
import type { ScanMachineState } from "./scanMachine";
import type { TorchApi } from "./useScanner";

export interface CameraViewProps {
  state: ScanMachineState;
  videoRef: RefObject<HTMLVideoElement | null>;
  torch: TorchApi;
  onRetry: () => void;
  onTypeInstead: () => void;
}

/**
 * §6.4 has no line for a stream the machine gave up on (`idle.lost`, and the
 * defensive `stream_lost` branch), so this one is supplied here.
 */
const CAMERA_STOPPED = "Camera stopped. It starts again when this screen is active.";

/** §6.4 has no line for the 1–3 s black frame while iOS opens the camera. Supplied here. */
const STARTING = "Starting camera…";

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
function statusFor(state: ScanMachineState): string {
  switch (state.kind) {
    case "requesting":
      return STARTING;
    case "streaming":
      return "Point at the barcode on the door-jamb sticker.";
    case "candidate":
      return "Reading… hold steady.";
    case "confirmed":
      return "Got it ✓";
    case "idle":
    case "error":
      // Handled by the notice, which carries its own alert role.
      return "";
  }
}

function statusToneFor(state: ScanMachineState): string {
  if (state.kind === "confirmed") return "text-ok";
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
  onRetry,
  onTypeInstead,
}: CameraViewProps): JSX.Element {
  const notice = noticeFor(state);
  const status = statusFor(state);
  const aiming = state.kind === "streaming" || state.kind === "candidate";
  const sighting = state.kind === "candidate" || state.kind === "confirmed" ? state.sighting : null;
  // Whichever route forward exists gets the 56 px primary target (§6.1).
  const typeVariant = notice !== null && !notice.retry ? "primary" : "secondary";

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="relative w-full flex-1 overflow-hidden rounded-[var(--radius)] border border-border bg-black">
        <div className="aspect-[3/4] max-h-[60vh] w-full">
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
            {/* The wide box matches a 1D barcode on a door-jamb label; the spread
                shadow dims everything outside it so the aim point survives glare. */}
            <div className="h-[22%] w-[90%] rounded-[var(--radius)] border-2 border-accent shadow-[0_0_0_100vmax_rgba(0,0,0,0.55)]" />
          </div>
        ) : null}

        {torch.available ? (
          <Button
            variant="secondary"
            onClick={torch.toggle}
            aria-pressed={torch.on}
            className="absolute right-3 bottom-3 px-4"
          >
            {torch.on ? "Torch on" : "Torch off"}
          </Button>
        ) : null}
      </div>

      <div
        role="status"
        aria-live="polite"
        className="flex min-h-[var(--tap)] flex-col items-start justify-center gap-2"
      >
        {status === "" ? null : (
          <p className={`text-lg leading-snug font-bold ${statusToneFor(state)}`}>{status}</p>
        )}
        {sighting === null ? null : (
          <VinDisplay vin={sighting.vin} size={state.kind === "confirmed" ? "lg" : "md"} />
        )}
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
  );
}
