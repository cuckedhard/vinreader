import { describe, expect, it } from "vitest";
import {
  CAMERA_STOPPED,
  cameraErrorText,
  missingMediaDevicesError,
  toCameraError,
} from "./cameraError";

/**
 * §6.4's camera block, and the classification that decides which line of it a user reads.
 *
 * The case worth the file is `permission_denied`. It is the only camera fault in the app
 * that the person holding the phone can undo, and the sentence is the only place the app
 * says how — so anything that collapses it into "the camera didn't start" costs a user the
 * fix. The capture screen shipped doing exactly that.
 */

/** The remedy clause each screen finishes the blocked line with. */
const VIN_FIELD = "or type the VIN.";
const PAINT_FIELD = "or type the code.";

describe("toCameraError", () => {
  it("names a refused permission, which is the one the user can reverse", () => {
    expect(toCameraError(new DOMException("denied", "NotAllowedError"))).toBe("permission_denied");
    // Safari answers a blocked camera on an untrusted certificate this way.
    expect(toCameraError(new DOMException("blocked", "SecurityError"))).toBe("permission_denied");
  });

  it("names a camera that is not there", () => {
    expect(toCameraError(new DOMException("none", "NotFoundError"))).toBe("no_camera");
    expect(toCameraError(new DOMException("no match", "OverconstrainedError"))).toBe("no_camera");
  });

  it("puts a camera that exists but will not open with the missing ones (§4.10 has no member)", () => {
    expect(toCameraError(new DOMException("in use", "NotReadableError"))).toBe("no_camera");
    expect(toCameraError(new DOMException("gone", "AbortError"))).toBe("no_camera");
    expect(toCameraError(new Error("who knows"))).toBe("no_camera");
    expect(toCameraError("a thrown string")).toBe("no_camera");
    expect(toCameraError(null)).toBe("no_camera");
  });
});

describe("missingMediaDevicesError", () => {
  it("does not call an insecure origin a missing camera (N2)", () => {
    expect(missingMediaDevicesError(false)).toBe("insecure_context");
    expect(missingMediaDevicesError(true)).toBe("no_camera");
  });
});

describe("cameraErrorText", () => {
  it("is §6.4's line, verbatim, where the keyboard route takes a VIN", () => {
    expect(cameraErrorText("permission_denied", VIN_FIELD)).toBe(
      "Camera is blocked. Allow camera for this site in your browser settings, or type the VIN.",
    );
    expect(cameraErrorText("insecure_context", VIN_FIELD)).toBe(
      "Camera needs a secure (https) connection.",
    );
    expect(cameraErrorText("no_camera", VIN_FIELD)).toBe("No camera is available on this device.");
    expect(cameraErrorText("stream_lost", VIN_FIELD)).toBe(CAMERA_STOPPED);
  });

  it("sends the user to the field the screen they are on actually has", () => {
    expect(cameraErrorText("permission_denied", PAINT_FIELD)).toBe(
      "Camera is blocked. Allow camera for this site in your browser settings, or type the code.",
    );
    // Only the blocked line takes one: the other three are whole sentences on either screen.
    for (const error of ["insecure_context", "no_camera", "stream_lost"] as const) {
      expect(cameraErrorText(error, PAINT_FIELD)).toBe(cameraErrorText(error, VIN_FIELD));
    }
  });

  it("never answers a blocked camera with a missing one", () => {
    // The whole finding in one line: these were the same sentence on the capture screen,
    // and only one of them tells the user where the switch is.
    expect(cameraErrorText("permission_denied", PAINT_FIELD)).not.toBe(
      cameraErrorText("no_camera", PAINT_FIELD),
    );
    expect(cameraErrorText("permission_denied", PAINT_FIELD)).toContain("browser settings");
  });
});
