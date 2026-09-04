/**
 * The scanner's decode boundary: what one frame out of ZXing turns into before anything in
 * the app acts on it (`readScanResult`). Pure, so it runs with no camera and no DOM, the way
 * `pickFocusMode` already does in `CameraView.test.ts`.
 *
 * Why it is worth pinning here and not only in `symbologies.test.ts`. That file proves
 * `stripAimIdentifier` removes `]C1` correctly; nothing proved the scan path ever called it.
 * §4.6's `ASSUME_GS1` shipped with the strip applied on the §13.4 bench and not on this
 * path, so the bench measured a program the app was not: a real leading-FNC1 label still
 * read as a 19-character run and was refused in the product, and every gate stayed green.
 * These tests fail if the call goes away, and they fail if it moves below either of the two
 * questions it has to sit above.
 */

import { BarcodeFormat } from "@zxing/library";
import { describe, expect, it } from "vitest";

import { TEXT_PREFIX, isPayloadCarrier } from "../../lib/payload/carrier";
import { encodePayload } from "../../lib/payload/codec";
import { extractVin } from "../../lib/vin/extractVin";
import { CODE_128_GS1_IDENTIFIER } from "../../lib/vin/symbologies";
import { readScanResult } from "./useScanner";

/** §4.11. */
const VIN = "1HGCM82633A004352";
/** Every FNC1 after the first (GS1 5.4.7.5), which §4.2 step 2 splits on. */
const GS = String.fromCharCode(29);
/** An arbitrary clock, passed in rather than read, so a sighting's stamp is checkable. */
const AT_MS = 1_700_000_000_000;

/** A decoded frame, as `Result` presents one to `decodeFromStream`'s callback. */
function frame(text: string, format: BarcodeFormat) {
  return { getText: () => text, getBarcodeFormat: () => format };
}

describe("readScanResult — the §4.6 strip is on the app's scan path, not only the bench's", () => {
  it("reads a leading-FNC1 Code 128 carrying only the VIN, which is the shape §4.6 regressed", () => {
    const read = readScanResult(
      frame(`${CODE_128_GS1_IDENTIFIER}${VIN}`, BarcodeFormat.CODE_128),
      AT_MS,
    );

    expect(read).toEqual({
      kind: "sighting",
      sighting: {
        vin: VIN,
        raw: VIN,
        checkDigitValid: true,
        symbology: "code_128",
        atMs: AT_MS,
      },
    });
  });

  it("keeps the GS separators a multi-field label was delimited with", () => {
    const read = readScanResult(
      frame(`${CODE_128_GS1_IDENTIFIER}${VIN}${GS}1P84203911`, BarcodeFormat.CODE_128),
      AT_MS,
    );

    expect(read).toMatchObject({
      kind: "sighting",
      sighting: { vin: VIN, raw: `${VIN}${GS}1P84203911`, symbology: "code_128" },
    });
  });

  /**
   * §5.2's `raw` is the label's bytes, not the decoder's output: `]C1` is not on the label,
   * it changes with a decoder hint rather than with the vehicle, and the read's own
   * configuration is already recorded in `symbology`. The property that settles it is here —
   * an event's `raw` still extracts to the `vin` stored beside it, which it would not if the
   * three invented bytes were logged.
   */
  it("logs a §5.2 raw that still extracts to the VIN the same event claims", () => {
    const read = readScanResult(
      frame(`${CODE_128_GS1_IDENTIFIER}9N123456789${GS}${VIN}`, BarcodeFormat.CODE_128),
      AT_MS,
    );

    expect(read?.kind).toBe("sighting");
    const sighting = read?.kind === "sighting" ? read.sighting : null;
    expect(extractVin(sighting?.raw ?? "")?.vin).toBe(sighting?.vin);
  });

  /**
   * The strip has to sit above the §4.9 carrier test, not merely above `extractVin`. The
   * text carrier prefix is anchored, so an identifier in front of it makes one of the app's
   * own payloads look like ordinary label data — and `extractVin` then mines its base64url
   * body, where roughly one 17-character window in eleven passes the check digit by chance
   * (D14, N2).
   */
  it("recognises the app's own carrier through the identifier, instead of mining it for a VIN", () => {
    const carrier = `${TEXT_PREFIX}${encodePayload({ v: 1, vin: VIN, mk: "HONDA" })}`;
    const asZxingReadsIt = `${CODE_128_GS1_IDENTIFIER}${carrier}`;

    // Why the order matters, stated as an assertion: unstripped, the prefix does not match.
    expect(isPayloadCarrier(asZxingReadsIt)).toBe(false);
    expect(isPayloadCarrier(carrier)).toBe(true);

    expect(readScanResult(frame(asZxingReadsIt, BarcodeFormat.CODE_128), AT_MS)).toEqual({
      kind: "carrier",
      text: carrier,
    });
  });

  /**
   * The strip is keyed on the reported format because `]C1` is the only AIM identifier
   * `@zxing/library` 0.23.0 emits, and only from `Code128Reader`. On any other symbology
   * those three characters are something a printer encoded, so they stay — and §4.2 then
   * refuses the 19-character run `C1` + VIN, exactly as it did before §4.6 gained the hint.
   */
  it("leaves a ]C1 that a printer really encoded alone on the other three symbologies", () => {
    for (const format of [
      BarcodeFormat.CODE_39,
      BarcodeFormat.DATA_MATRIX,
      BarcodeFormat.QR_CODE,
    ]) {
      expect(readScanResult(frame(`${CODE_128_GS1_IDENTIFIER}${VIN}`, format), AT_MS)).toBeNull();
    }
  });
});

describe("readScanResult — everything else about a frame, unchanged", () => {
  it("reads the ANSI MH10.8.2 door-label form, identifier and all, off Code 39", () => {
    expect(readScanResult(frame(`I${VIN}`, BarcodeFormat.CODE_39), AT_MS)).toEqual({
      kind: "sighting",
      sighting: {
        vin: VIN,
        // §5.2 keeps what the label carried: the `I` is printed, unlike `]C1`.
        raw: `I${VIN}`,
        checkDigitValid: true,
        symbology: "code_39",
        atMs: AT_MS,
      },
    });
  });

  it("says nothing about a frame §4.2 refuses", () => {
    expect(readScanResult(frame("UNIT B — REAR AXLE", BarcodeFormat.CODE_39), AT_MS)).toBeNull();
  });

  it("drops a format outside §4.6 rather than inventing a symbology for it", () => {
    expect(readScanResult(frame(VIN, BarcodeFormat.EAN_13), AT_MS)).toBeNull();
  });
});
