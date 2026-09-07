/**
 * Why a camera did not start, and what the app says about it — one rule for both screens.
 *
 * The scan screen has answered this since S1: §4.10 names four `ScanError`s, `getUserMedia`
 * is classified into them, and §6.4 gives each a sentence. The one that matters is
 * `permission_denied`, which is the only camera sentence in the app that tells a user how
 * to undo what happened.
 *
 * The capture screen (S5 layer 2) shipped without any of it. Every rejection landed in one
 * flag and one line — "The camera didn't start here. You can still type the code." — which
 * says neither what happened nor how to fix it, and quietly threw the remedy away: a user
 * who had denied the permission was told to give up and type, on a screen that could have
 * told them where the switch is. Two screens, one fault, two answers, and the newer one is
 * the worse one.
 *
 * So the classification and the sentences live here and both screens use them. The remedy
 * clause is the caller's, because it is the only part that genuinely differs: the scan
 * screen's keyboard route takes a VIN and the capture screen's takes a paint code, and a
 * sentence that sends a user to the wrong field is not a remedy. §6.4's line is the one
 * `CameraView` passes.
 */
import type { ScanError } from "../lib/vin/types";

/**
 * A `getUserMedia` rejection, as §4.10 names it.
 *
 * `NotReadableError` (the camera is held by another app), `AbortError` and anything
 * unknown land in `no_camera`: §4.10 has no member for a camera that exists but will not
 * open, and from where the user stands it is unavailable either way.
 */
export function toCameraError(error: unknown): ScanError {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "permission_denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "no_camera";
    default:
      return "no_camera";
  }
}

/**
 * No `mediaDevices` at all. On an insecure origin the whole API is missing rather than
 * refusing, and "No camera is available on this device" would then be a claim about the
 * hardware that the app cannot see and that happens to be false (N2). §6.3 makes the same
 * check before the scan screen ever prompts.
 */
export function missingMediaDevicesError(secureContext: boolean): ScanError {
  return secureContext ? "no_camera" : "insecure_context";
}

/** §6.4, `idle.lost` and the defensive `stream_lost` branch. */
export const CAMERA_STOPPED = "Camera stopped. It starts again when this screen is active.";

/**
 * §6.4's four camera sentences.
 *
 * `typeInstead` finishes the blocked line and nothing else — §6.4 writes it "or type the
 * VIN." on the scan screen. The other three are whole sentences on either screen: the
 * typed field is on screen in every state of both, so the route out does not need naming
 * twice in one banner.
 */
export function cameraErrorText(error: ScanError, typeInstead: string): string {
  switch (error) {
    case "permission_denied":
      return `Camera is blocked. Allow camera for this site in your browser settings, ${typeInstead}`;
    case "insecure_context":
      return "Camera needs a secure (https) connection.";
    case "no_camera":
      // §6.4 has no line. Supplied in S1, and it blames the device, not the user.
      return "No camera is available on this device.";
    case "stream_lost":
      return CAMERA_STOPPED;
  }
}
