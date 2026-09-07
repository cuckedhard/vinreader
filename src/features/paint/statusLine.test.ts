import { describe, expect, it } from "vitest";
import { STARTING_CAMERA } from "../../app/strings";
import { OCR_TOTAL_BYTES } from "../../lib/ocr/assets.generated";
import type { OcrLine } from "../../lib/ocr/types";
import { AIM, NOTHING, megabytes, statusLine } from "./statusLine";

/**
 * The two states in here that no other instrument can hold still.
 *
 * A five-frame read and a 4.5 MB download are over long before a Playwright assertion can
 * read the line they put on screen, so what the user is told during either is pinned here
 * or nowhere. The interesting one is `reading`: it shipped saying "Reading… hold steady
 * (3 of 5)", which is §6.4's Scan `candidate` sentence — a sentence that means *a first
 * VIN has been seen and a second read is wanted* — used for a state with no candidate in
 * it at all.
 */

const line = (text: string): OcrLine => ({ text, confidence: 90, chars: [], tokens: [] });

describe("statusLine", () => {
  it("offers the box to aim with once the camera is up, and says so before that", () => {
    expect(statusLine({ kind: "offer" }, true)).toBe(AIM);
    expect(statusLine({ kind: "offer" }, false)).toBe(STARTING_CAMERA);
  });

  it("counts a download in the megabytes the offer counted", () => {
    expect(statusLine({ kind: "downloading", loadedBytes: 400_000, totalBytes: 4_483_231 }, true)).toBe(
      "Downloading the reader… 0.4 of 4.5 MB",
    );
    // The offer's "a 4.5 MB reader" and this line are the same number by construction.
    expect(megabytes(OCR_TOTAL_BYTES)).toBe("4.5");
  });

  /**
   * §6.4 gives *"Reading… hold steady."* to the Scan `candidate` state. Frames going into a
   * vote is a different fact, so it gets different words — shaped like the download line
   * above it, and keeping the instruction, which is the half that is true of both.
   */
  it("says which frame is being read, in words the scan screen has not already spent", () => {
    expect(statusLine({ kind: "reading", lines: [], total: 5 }, true)).toBe(
      "Reading the code… 1 of 5. Hold steady.",
    );
    expect(
      statusLine({ kind: "reading", lines: [line("WA8555"), line("WA8555")], total: 5 }, true),
    ).toBe("Reading the code… 3 of 5. Hold steady.");
  });

  it("says nothing at all once there is something on screen to decide", () => {
    expect(statusLine({ kind: "nothing" }, true)).toBe(NOTHING);
    expect(statusLine({ kind: "unsupported", reason: "no_wasm" }, true)).toBeNull();
    expect(statusLine({ kind: "failed", reason: "aborted" }, true)).toBeNull();
  });
});
