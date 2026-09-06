import { describe, expect, it } from "vitest";
import { normalizeVehicle } from "./normalize";
import { buildStructural } from "../vin/structural";
import type { VehicleRecord } from "../vin/types";

const VIN = "1HGCM82633A004352";

/** The row shape §4.12 produces when `apply_scan_event` creates it before any meta push. */
function syncShaped(): VehicleRecord {
  return {
    vin: VIN,
    structural: {} as VehicleRecord["structural"],
    decode: {} as VehicleRecord["decode"],
    unit: null,
    notes: null,
    paint: null,
    firstScannedAt: "2026-01-01T00:00:00.000+00:00",
    lastScannedAt: "2026-01-01T00:00:00.000+00:00",
    scanCount: 1,
    origin: "scan",
    metaUpdatedAt: "1970-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

/** The normaliser returns null for a row it cannot rebuild; these cases all can be. */
function must(row: VehicleRecord | null): VehicleRecord {
  if (row === null) throw new Error("expected a normalisable row");
  return row;
}

describe("normalizeVehicle", () => {
  it("rebuilds an empty structural block from the VIN rather than defending against it", () => {
    const got = must(normalizeVehicle(syncShaped(), 2026));
    // The VIN is the primary key, so structural is always recoverable (§4.1–§4.5).
    expect(got.structural).toEqual(buildStructural(VIN, 2026));
    expect(got.structural.modelYear.resolved).toBe(2003);
    expect(got.structural.region).toBe("North America");
  });

  it("defaults an empty decode block to pending", () => {
    const got = must(normalizeVehicle(syncShaped(), 2026));
    expect(got.decode).toEqual({
      status: "pending",
      source: "nhtsa_vpic",
      fetchedAt: null,
      attempts: 0,
      lastError: null,
      fields: {},
    });
  });

  it("reads a row written before the paint code existed as having none", () => {
    // §5.1 `paint` (S5) is unindexed, so no Dexie version bump declared it and no upgrade
    // wrote it: a record stored by S0–S4 simply has no such property. The read path is
    // where that becomes `null`, the same value a fresh record carries — the alternative
    // is `undefined` reaching the Sheet, the CSV and the §4.9 payload.
    const older = { ...syncShaped() } as Partial<VehicleRecord>;
    delete older.paint;
    expect(must(normalizeVehicle(older as VehicleRecord, 2026)).paint).toBeNull();
  });

  it("reads a stored value that is not a string as no paint code at all", () => {
    // N2: a row that came back from §4.12 carrying a number where a string belongs has no
    // paint code to show. Rendering `7` as one would be a fact nobody typed.
    const wrong = { ...syncShaped(), paint: 7 } as unknown as VehicleRecord;
    expect(must(normalizeVehicle(wrong, 2026)).paint).toBeNull();
  });

  it("keeps a paint code a human typed", () => {
    const typed = { ...syncShaped(), paint: "NH-731P" };
    expect(must(normalizeVehicle(typed, 2026)).paint).toBe("NH-731P");
  });

  it("leaves a complete record untouched", () => {
    const complete: VehicleRecord = {
      ...syncShaped(),
      structural: buildStructural(VIN, 2026),
      decode: {
        status: "ok",
        source: "nhtsa_vpic",
        fetchedAt: "2026-01-02T00:00:00.000+00:00",
        attempts: 1,
        lastError: null,
        fields: { Make: "HONDA" },
      },
    };
    expect(must(normalizeVehicle(complete, 2026))).toEqual(complete);
  });

  it("keeps a populated decode that is missing its fields map", () => {
    const row = syncShaped();
    row.decode = {
      status: "partial",
      source: "nhtsa_vpic",
      fetchedAt: null,
      attempts: 2,
      lastError: "boom",
    } as VehicleRecord["decode"];
    const got = must(normalizeVehicle(row, 2026));
    expect(got.decode.status).toBe("partial");
    expect(got.decode.attempts).toBe(2);
    expect(got.decode.lastError).toBe("boom");
    expect(got.decode.fields).toEqual({});
  });

  it("carries every field outside the two blocks through unchanged", () => {
    const row = { ...syncShaped(), unit: "UNIT-42", notes: "rear light out", scanCount: 3 };
    const got = must(normalizeVehicle(row, 2026));
    expect(got.unit).toBe("UNIT-42");
    expect(got.notes).toBe("rear light out");
    expect(got.scanCount).toBe(3);
    expect(got.metaUpdatedAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("returns null for a row with no grammar-valid VIN, so callers drop that row alone", () => {
    // P7: one unreadable row costs that row, not the route. buildStructural cannot run on
    // a missing or malformed key, and throwing inside a live query kills the whole screen.
    for (const vin of ["", "not-a-vin", "1HGCM8263IA004352", undefined as unknown as string]) {
      expect(normalizeVehicle({ ...syncShaped(), vin }, 2026)).toBeNull();
    }
  });
});

/**
 * Round 3. Everything above executes the whole of `normalizeVehicle`, but three of its
 * decisions are only *executed*, never *asserted*: nothing would fail if the structural
 * rebuild became conditional again, if `currentYear` were ignored in favour of a clock
 * read, or if the row handed in were mutated in place. The first is the round-2 review's
 * second rejection ("the structural guard did not close the class it named") and the one
 * most likely to be reverted by someone who reads the rebuild as wasted work.
 */
describe("normalizeVehicle — the decisions the cases above only execute", () => {
  it("rebuilds a structural block that disagrees with the VIN instead of trusting it", () => {
    // A guard that kept a populated block would keep this one, and the Sheet would show
    // another vehicle's year, plant and country under this VIN (N2). The block is a pure
    // function of the 17 characters and the VIN is the primary key, so the stored copy is
    // never evidence about anything — which is also how a record written before a
    // constants fix heals itself on the next read.
    const wrong = buildStructural("JH4KA7561PC008269", 2026);
    const got = must(normalizeVehicle({ ...syncShaped(), structural: wrong }, 2026));

    expect(got.structural).toEqual(buildStructural(VIN, 2026));
    expect(got.structural.wmi).toBe("1HG");
    expect(got.structural.serial).toBe("004352");
    expect(got.structural).not.toEqual(wrong);
  });

  it("uses the year it is given, not the year the machine happens to be on", () => {
    // §4.4 is resolved against `currentYear`, and P3 keeps that an argument rather than a
    // clock read so the whole of §4 stays deterministic. The VIN below is the ambiguous
    // case: position 10 `T` is 1996 or 2026, and position 7 is a digit, so nothing but the
    // §4.4 cap can decide. A normaliser that reached for `new Date()` would agree with
    // this test today and disagree with it every January.
    const ambiguous = "1HGCM8263TA004352";
    const row = { ...syncShaped(), vin: ambiguous };

    expect(must(normalizeVehicle(row, 2026)).structural.modelYear).toEqual({
      candidates: [1996, 2026],
      resolved: null,
    });
    expect(must(normalizeVehicle(row, 2010)).structural.modelYear).toEqual({
      candidates: [1996],
      resolved: 1996,
    });
  });

  it("defaults a decode block that is absent altogether, not merely empty", () => {
    // §4.12 defaults the column to `'{}'::jsonb`, but a pull can also deliver the key
    // missing or null. `{}` is the only shape the cases above pass in, and it takes a
    // different path through the spread than `undefined` does.
    for (const decode of [undefined, null]) {
      const row = { ...syncShaped(), decode: decode as unknown as VehicleRecord["decode"] };
      expect(must(normalizeVehicle(row, 2026)).decode).toEqual({
        status: "pending",
        source: "nhtsa_vpic",
        fetchedAt: null,
        attempts: 0,
        lastError: null,
        fields: {},
      });
    }
  });

  it("rejects a vin that is not a string, including one that would coerce to a valid one", () => {
    // "returns null for a row with no grammar-valid VIN" proves the *grammar* half of that
    // guard, and it is the only case that reaches the `typeof` half at all — but every
    // value it passes in fails the grammar too, so the type check is never what decided.
    // It has to be: §4.1's check is a regex and `RegExp.test` coerces its argument first,
    // so a one-element array, or anything at all with a `toString`, reads to it as a
    // perfectly valid VIN. The type check is then the only thing between a corrupted row
    // (§13.2) and `buildStructural`, which would slice a non-string and hand back a record
    // whose primary key is not a key. Dexie stores what it is given and IndexedDB keeps
    // the type, so this is a shape a §5.6 import or a half-written row can really produce.
    for (const vin of [[VIN], { toString: () => VIN }, Object(VIN)]) {
      expect(
        normalizeVehicle({ ...syncShaped(), vin } as unknown as VehicleRecord, 2026),
      ).toBeNull();
    }
  });

  it("leaves the row it was handed exactly as it found it", () => {
    // The rows come out of a Dexie live query, and in dev React renders the same objects
    // twice. A normaliser that filled the blocks in place would look identical on the
    // first pass and would then be normalising its own output — and would write through
    // to whatever else holds that row.
    const row = syncShaped();
    const before = JSON.stringify(row);
    const got = must(normalizeVehicle(row, 2026));

    expect(JSON.stringify(row)).toBe(before);
    expect(got).not.toBe(row);
    expect(got.structural).not.toBe(row.structural);
    expect(got.decode).not.toBe(row.decode);
  });
});
