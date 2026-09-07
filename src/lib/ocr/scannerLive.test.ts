/**
 * The interlock between the two camera paths.
 *
 * If this reports "free" while ZXing is streaming, OCR starts a second frame loop on a
 * phone that is already decoding every frame — N1/P1, and the reason `engine.ts` makes
 * `isScannerLive` a required dependency rather than an option.
 */
import { describe, expect, it } from "vitest";
import { acquireScanner, isScannerLive, openScannerCamera } from "./scannerLive";

/** A stream that records whether anything stopped it. */
function fakeStream(): MediaStream & { stopped: number } {
  let stopped = 0;
  const track = { stop: () => (stopped += 1) } as unknown as MediaStreamTrack;
  return {
    get stopped() {
      return stopped;
    },
    getTracks: () => [track],
  } as unknown as MediaStream & { stopped: number };
}

const ANY_CONSTRAINTS: MediaStreamConstraints = { video: true };

describe("scannerLive", () => {
  it("is free until something takes it, and free again after", () => {
    expect(isScannerLive()).toBe(false);
    const release = acquireScanner();
    expect(isScannerLive()).toBe(true);
    release();
    expect(isScannerLive()).toBe(false);
  });

  it("stays live while a second session overlaps the first", () => {
    // The scan screen remounting: the next stream is acquired before the last is released.
    const first = acquireScanner();
    const second = acquireScanner();
    first();
    expect(isScannerLive()).toBe(true);
    second();
    expect(isScannerLive()).toBe(false);
  });

  it("counts a double release once, so a stray cleanup cannot report a live camera free", () => {
    const release = acquireScanner();
    const other = acquireScanner();
    release();
    release();
    release();
    expect(isScannerLive()).toBe(true);
    other();
    expect(isScannerLive()).toBe(false);
  });
});

/**
 * The half of the interlock that had nothing holding it up.
 *
 * `useScanner` used to call `acquireScanner()` on a line of its own inside the camera
 * effect. No unit test could see it — `vitest.config.ts` pins `environment: "node"` with
 * no jsdom — and no e2e could either, because `#/scan` and `#/v/:vin/paint` are sibling
 * routes and the scan screen's cleanup runs before the capture screen mounts, so the two
 * are never live at once for a browser to catch a `scanner_live` refusal in. Deleting the
 * line reddened nothing, on the rule that a scan must never be blocked (N1/P1).
 *
 * The lock is now taken with the stream, which is a thing this file can drive and a thing
 * `useScanner` cannot skip and still have a camera.
 */
describe("openScannerCamera", () => {
  it("reports the scanner live from the moment the camera is asked for", async () => {
    const stream = fakeStream();
    let liveWhileAsking = false;
    const media = {
      getUserMedia: async () => {
        // Across the await, not after it: a permission prompt is the longest part of this
        // and iOS caps fast WASM memories at three per web-content process (§4).
        liveWhileAsking = isScannerLive();
        return stream;
      },
    } as unknown as MediaDevices;

    const camera = await openScannerCamera(media, ANY_CONSTRAINTS);
    expect(liveWhileAsking).toBe(true);
    expect(isScannerLive()).toBe(true);
    expect(camera.stream).toBe(stream);

    camera.close();
    expect(isScannerLive()).toBe(false);
  });

  it("stops the tracks it opened, and does it once however often it is closed", async () => {
    const stream = fakeStream();
    const media = { getUserMedia: async () => stream } as unknown as MediaDevices;
    const camera = await openScannerCamera(media, ANY_CONSTRAINTS);

    camera.close();
    camera.close();
    camera.close();
    expect(stream.stopped).toBe(1);
    // And the count came back to zero once, not three times below it: a stray second
    // cleanup must not report a camera someone else is holding as free.
    const other = acquireScanner();
    expect(isScannerLive()).toBe(true);
    other();
    expect(isScannerLive()).toBe(false);
  });

  it("leaves the scanner free when the camera is refused", async () => {
    const denied = new Error("NotAllowedError");
    const media = {
      getUserMedia: async () => {
        throw denied;
      },
    } as unknown as MediaDevices;

    await expect(openScannerCamera(media, ANY_CONSTRAINTS)).rejects.toBe(denied);
    // There is no camera, so there is nothing to interlock against. A refused permission
    // that left the lock held would refuse OCR for the life of the page, silently.
    expect(isScannerLive()).toBe(false);
  });

  it("passes the constraints it was given through untouched", async () => {
    const seen: MediaStreamConstraints[] = [];
    const media = {
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        seen.push(constraints);
        return fakeStream();
      },
    } as unknown as MediaDevices;

    const constraints: MediaStreamConstraints = { video: { facingMode: { ideal: "environment" } } };
    const camera = await openScannerCamera(media, constraints);
    expect(seen).toEqual([constraints]);
    camera.close();
  });
});
