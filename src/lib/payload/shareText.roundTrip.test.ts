/**
 * §4.9 round trip: the app reading its own output.
 *
 * The workflow this guards is the obvious one — Copy summary on the sheet (§6.5), text
 * the block to the shop, the shop pastes it into Import (§6.2) — and it was broken with
 * no test to say so. `shareText` had tests for what it emits and `extractVin` had tests
 * for what it reads, and nothing joined the two, so §4.2's rule could change twice (Z6,
 * then R4-A) and take the round trip with it unnoticed.
 *
 * Measured before the fix, on all three shapes below: 0 of 3 read back.
 */

import { describe, expect, it } from "vitest";

import { extractVin } from "../vin/extractVin";
import { groupVin } from "../vin/grammar";
import { buildStructural } from "../vin/structural";
import type { VehicleDecode, VehicleRecord } from "../vin/types";
import { META_NEVER_EDITED } from "../vin/types";
import { parseCarrier } from "./codec";
import { parseShareTextVin, shareText } from "./shareText";

/** §4.11 fixture: check digit valid, year resolves to 2003 against a 2026 clock. */
const VIN = "1HGCM82633A004352";

/**
 * §4.11's "synthetic year tests" row: position 10 `T` with a digit in position 7, so both
 * 1996 and 2026 survive the §4.4 cap and nothing resolves. Position 9 is `Z`, so §4.3 does
 * not apply either. It is the record that produces the SHORTEST §4.9 block — the VIN line
 * and the trailer, nothing else — which is the shape the auditor found had never worked.
 */
const VIN_NO_YEAR = "WVWZZZ1JZTW123456";

/** §4.1 display grouping, which is what §4.9 prints and therefore what has to read back. */
const GROUPED = groupVin(VIN);

const AT = "2026-09-04T12:00:00-08:00";

function decode(fields: Record<string, string>): VehicleDecode {
  return {
    status: "ok",
    source: "nhtsa_vpic",
    fetchedAt: AT,
    attempts: 1,
    lastError: null,
    fields,
  };
}

function record(vin: string, fields: Record<string, string>, unit: string | null): VehicleRecord {
  return {
    vin,
    structural: buildStructural(vin, 2026),
    decode: decode(fields),
    unit,
    notes: null,
    firstScannedAt: AT,
    lastScannedAt: AT,
    scanCount: 1,
    origin: "scan",
    metaUpdatedAt: META_NEVER_EDITED,
    deletedAt: null,
  };
}

/**
 * The three shapes §4.9 can take, from the fullest to the barest. vPIC fills the first;
 * the second is a scan that has not been decoded yet, or one NHTSA could not decode
 * (§4.7), where the structural year is all there is; the third has not even that.
 */
const SHAPES: readonly { name: string; record: VehicleRecord }[] = [
  {
    name: "decoded by vPIC",
    record: record(VIN, { ModelYear: "2003", Make: "HONDA", Model: "Accord" }, "UNIT-42"),
  },
  { name: "no vPIC fields, structural year only", record: record(VIN, {}, "UNIT-42") },
  { name: "no vPIC fields, no resolved year, no unit", record: record(VIN_NO_YEAR, {}, null) },
];

/**
 * The paste path from `ImportScreen.readPaste`, in the order the screen tries it: a §4.9
 * carrier first, then this app's other own format, then §4.2 over bytes no format claims
 * (D14). Written out here rather than imported because the screen is a React component and
 * this gate runs in `node` with no DOM; the e2e round trip in `tests/e2e/handoff.spec.ts`
 * pastes into the real screen, and is what holds these three lines in step with it.
 */
function pastedVin(raw: string): string | null {
  const carrier = parseCarrier(raw);
  if (carrier !== null) return carrier.vin;
  return parseShareTextVin(raw) ?? extractVin(raw)?.vin ?? null;
}

describe("§4.9 share text imports back into the app that wrote it", () => {
  for (const shape of SHAPES) {
    it(`round-trips a record ${shape.name}`, () => {
      expect(pastedVin(shareText(shape.record))).toBe(shape.record.vin);
    });
  }

  it("reads a block a client lower-cased and rewrote the line endings of", () => {
    const mangled = shareText(SHAPES[0].record).toLowerCase().replace(/\n/g, "\r\n");
    expect(pastedVin(mangled)).toBe(VIN);
  });

  it("reads the VIN line on its own, which is all a forwarded message may keep", () => {
    expect(pastedVin(`VIN ${GROUPED}`)).toBe(VIN);
  });
});

/**
 * Characterisation, in the §13.2 sense: this is not a rule anyone wants, it is the record
 * of WHY the recogniser exists, kept executable. §4.2 step 1 strips the whitespace before
 * step 2 splits, so "VIN " fuses onto the grouped VIN and leaves an 18-character run whose
 * two windows R4-A refuses. If one of these ever goes green, §4.2 changed — read this file
 * and `parseShareTextVin` before deleting either.
 */
describe("why the recogniser exists: §4.2 alone cannot read §4.9's own block", () => {
  for (const shape of SHAPES) {
    it(`refuses the block for a record ${shape.name}`, () => {
      expect(extractVin(shareText(shape.record))).toBeNull();
    });
  }

  it("refuses even the VIN line by itself, though the VIN alone reads", () => {
    expect(extractVin(`VIN ${GROUPED}`)).toBeNull();
    expect(extractVin(VIN)?.vin).toBe(VIN);
  });
});

/**
 * The other half of the bargain. §4.2 pays for its refusals to buy zero fabrications
 * (R4-A), and a recogniser that handed some of those back would be the same defect through
 * a new door. It cannot: the VIN has to be the whole content of a labelled line, so no
 * window slides and there is nothing for a straddle to straddle.
 */
describe("the recogniser fabricates nothing §4.2 refuses", () => {
  /** The §4.11 / R4-A corpus: the shapes `extractVin.straddle.test.ts` guards. */
  const REFUSED = [
    // §4.11: a §4.1-legal character in front of a misread VIN, the R4-A population.
    "B1HGCM82633A004353",
    // §4.11: a valid VIN with one stray trailing character — the same run, byte for byte.
    "1HGCM82633A0043521",
    // §4.11: two identifiers run together.
    "1HGCM82633A0043531HGCM82633A004352",
    // R2-01: an off-highway PIN sharing a run with a field label (§4.7, no check digit).
    "PIN JCB4CX00CJ2345678",
    // §4.11: a 16-character VIN, and one containing `I`.
    "1HGCM82633A00435",
    "1HGCM8263IA004352",
  ];

  for (const raw of REFUSED) {
    it(`refuses ${raw}`, () => {
      expect(parseShareTextVin(raw)).toBeNull();
      // With the label in front, too: the label does not make a bad run readable, because
      // the whole of what follows it has to be the VIN and none of these is.
      expect(parseShareTextVin(`VIN ${raw}`)).toBeNull();
    });
  }

  it("refuses a labelled line carrying anything besides the VIN", () => {
    expect(parseShareTextVin(`VIN ${VIN} (rear axle)`)).toBeNull();
    expect(parseShareTextVin(`Unit B VIN ${VIN}`)).toBeNull();
  });

  it("refuses two different labelled VINs rather than choosing one (N2)", () => {
    const two = `VIN ${GROUPED}\nVIN ${groupVin(VIN_NO_YEAR)}`;
    expect(parseShareTextVin(two)).toBeNull();
  });

  it("counts the same VIN labelled twice as one answer, as §4.2 4(a) counts windows", () => {
    expect(parseShareTextVin(`VIN ${GROUPED}\nVIN ${VIN}`)).toBe(VIN);
  });

  it("does not read the §4.9 trailer, or any other line, as a VIN", () => {
    expect(parseShareTextVin("VIN Relay")).toBeNull();
    expect(parseShareTextVin("2003 HONDA Accord")).toBeNull();
    expect(parseShareTextVin("")).toBeNull();
  });

  /**
   * D17: a mismatch is shown on the preview and never enforced, so the recogniser reads a
   * VIN the sender already accepted — the same rule every other import path follows.
   */
  it("returns a VIN whose check digit does not match, for the preview to mark", () => {
    expect(parseShareTextVin("VIN 1HGCM82633A004353")).toBe("1HGCM82633A004353");
  });
});
