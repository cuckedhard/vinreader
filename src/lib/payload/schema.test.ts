import { describe, expect, it } from "vitest";

import { buildStructural } from "../vin/structural";
import type { VehicleRecord } from "../vin/types";
import type { ExportBundle, Payload } from "./schema";
import { exportBundleSchema, PAYLOAD_VERSION, payloadSchema, vehicleRecordSchema } from "./schema";

const VIN = "1HGCM82633A004352";

/** §4.9's example, `"tr": ""` verbatim. */
const EXAMPLE: Payload = {
  v: 1,
  vin: VIN,
  y: "2003",
  mk: "HONDA",
  md: "Accord",
  tr: "",
  bc: "Sedan/Saloon",
  en: "K24A4",
  fu: "Gasoline",
  dr: "FWD",
  gv: "Class 1: 6,000 lb or less",
  at: "2026-09-03T14:12:00-08:00",
  u: "UNIT-42",
  n: "Rear bumper scuffed",
  by: "Zach's iPhone",
};

function record(overrides: Partial<VehicleRecord> = {}): VehicleRecord {
  return {
    vin: VIN,
    structural: buildStructural(VIN, 2026),
    decode: {
      status: "ok",
      source: "nhtsa_vpic",
      fetchedAt: "2026-09-03T14:13:00.000-08:00",
      attempts: 1,
      lastError: null,
      fields: { ModelYear: "2003", Make: "HONDA", Model: "Accord" },
    },
    unit: "UNIT-42",
    notes: null,
    paint: null,
    firstScannedAt: "2026-09-01T09:00:00.000-08:00",
    lastScannedAt: "2026-09-03T14:12:00.000-08:00",
    scanCount: 2,
    origin: "scan",
    metaUpdatedAt: "1970-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

/** What a truncated or hand-edited file looks like: one block gone. */
function without(value: object, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
}

describe("payloadSchema", () => {
  it("accepts the §4.9 example", () => {
    expect(payloadSchema.parse(EXAMPLE)).toEqual(EXAMPLE);
  });

  it("accepts a payload carrying nothing but `v` and `vin`", () => {
    expect(payloadSchema.parse({ v: PAYLOAD_VERSION, vin: VIN })).toEqual({ v: 1, vin: VIN });
  });

  it("pins `v` to this build's version — `codec.ts` names the mismatch first", () => {
    expect(payloadSchema.safeParse({ ...EXAMPLE, v: 2 }).success).toBe(false);
    expect(payloadSchema.safeParse({ vin: VIN }).success).toBe(false);
  });

  it("requires a VIN that satisfies the §4.1 grammar", () => {
    expect(payloadSchema.safeParse({ v: 1 }).success).toBe(false);
    // §5.3 keys records by VIN, so nothing else may enter as one.
    expect(payloadSchema.safeParse({ v: 1, vin: "" }).success).toBe(false);
    expect(payloadSchema.safeParse({ v: 1, vin: VIN.toLowerCase() }).success).toBe(false);
    expect(payloadSchema.safeParse({ v: 1, vin: VIN.slice(0, 16) }).success).toBe(false);
    expect(payloadSchema.safeParse({ v: 1, vin: `${VIN}1` }).success).toBe(false);
    // I, O and Q are outside the alphabet.
    expect(payloadSchema.safeParse({ v: 1, vin: "1HGCM8263IA004352" }).success).toBe(false);
    expect(payloadSchema.safeParse({ v: 1, vin: "1HG CM826 3 3 A 004352" }).success).toBe(false);
  });

  it("accepts the ISO 8601 offsets §5.1 writes, and refuses anything else for `at`", () => {
    for (const at of [
      "2026-09-03T14:12:00-08:00",
      "2026-09-03T14:12:00.000-08:00",
      "2026-09-03T14:12:00Z",
      "2026-09-03T14:12:00.000Z",
      "2026-09-03T14:12:00+05:30",
    ]) {
      expect(payloadSchema.safeParse({ v: 1, vin: VIN, at }).success).toBe(true);
    }
    // §4.12 compares timestamps by `Date.parse`; an unparseable one would poison that.
    for (const at of ["yesterday", "2026-09-03", "2026-09-03T14:12:00", "", "1757000000000"]) {
      expect(payloadSchema.safeParse({ v: 1, vin: VIN, at }).success).toBe(false);
    }
  });

  it("refuses a summary field that is not a string", () => {
    expect(payloadSchema.safeParse({ v: 1, vin: VIN, mk: 42 }).success).toBe(false);
    expect(payloadSchema.safeParse({ v: 1, vin: VIN, n: null }).success).toBe(false);
    expect(payloadSchema.safeParse({ v: 1, vin: VIN, y: 2003 }).success).toBe(false);
  });

  it("drops a key it does not know rather than failing on it", () => {
    expect(payloadSchema.parse({ v: 1, vin: VIN, zz: "from a later build" })).toEqual({
      v: 1,
      vin: VIN,
    });
  });

  it("refuses input that is not an object at all", () => {
    for (const input of [null, "1HGCM82633A004352", 7, [], undefined]) {
      expect(payloadSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe("vehicleRecordSchema", () => {
  it("accepts a record that has been through JSON, which is how one arrives", () => {
    const parsed: unknown = JSON.parse(JSON.stringify(record()));
    expect(vehicleRecordSchema.parse(parsed)).toEqual(record());
  });

  it("accepts the epoch `metaUpdatedAt` a never-edited record carries (D11)", () => {
    expect(vehicleRecordSchema.safeParse(record()).success).toBe(true);
  });

  it("accepts a soft-deleted record and a `cloud` origin (§4.12)", () => {
    const deleted = record({ origin: "cloud", deletedAt: "2026-09-04T08:00:00.000-08:00" });
    expect(vehicleRecordSchema.safeParse(deleted).success).toBe(true);
  });

  it("refuses a value outside the §4.10 enums", () => {
    expect(vehicleRecordSchema.safeParse(record({ origin: "email" as never })).success).toBe(false);
    expect(
      vehicleRecordSchema.safeParse(
        record({ decode: { ...record().decode, status: "maybe" as never } }),
      ).success,
    ).toBe(false);
    expect(
      vehicleRecordSchema.safeParse(
        record({ structural: { ...buildStructural(VIN, 2026), region: "Antarctica" as never } }),
      ).success,
    ).toBe(false);
  });

  it("refuses a missing block, a bad VIN and a bad timestamp", () => {
    expect(vehicleRecordSchema.safeParse(without(record(), "structural")).success).toBe(false);
    expect(vehicleRecordSchema.safeParse(record({ vin: "NOT A VIN" })).success).toBe(false);
    expect(vehicleRecordSchema.safeParse(record({ lastScannedAt: "just now" })).success).toBe(
      false,
    );
    expect(vehicleRecordSchema.safeParse(record({ scanCount: 1.5 })).success).toBe(false);
  });

  it("reads a record exported before S5 as one with no paint code", () => {
    // §5.1 `paint` arrived in S5; every `.json` record and export bundle this app wrote
    // before it has no such key. Refusing those would make an app that cannot read its
    // own files, so the key defaults rather than being required — and it defaults to
    // null, which is "nobody typed one" and not an empty string that would render (N2).
    const older = without(record({ paint: "NH-731P" }), "paint");
    const parsed = vehicleRecordSchema.parse(older);
    expect(parsed.paint).toBeNull();
  });

  it("carries a paint code through verbatim, without validating it into a shape", () => {
    // §4.9: no check digit, no shared grammar — Toyota `1F7`, Ford `UG`, GM `WA8555`.
    // Anything that constrained the string here would refuse a real code from a
    // manufacturer nobody thought of, so only its type is checked.
    for (const code of ["1F7", "NH-731P", "UG", "LC9X", "WA8555", "202 / 040"]) {
      expect(vehicleRecordSchema.parse(record({ paint: code })).paint).toBe(code);
    }
    expect(vehicleRecordSchema.safeParse(record({ paint: 7 as never })).success).toBe(false);
  });

  it("keeps `decode.fields` as vPIC returned it", () => {
    const fields = { ModelYear: "2003", Make: "HONDA", SomeKeyAddedLater: "value" };
    const parsed = vehicleRecordSchema.parse(record({ decode: { ...record().decode, fields } }));
    expect(parsed.decode.fields).toEqual(fields);
  });
});

describe("exportBundleSchema", () => {
  const bundle: ExportBundle = {
    app: "vin-relay",
    v: 1,
    exportedAt: "2026-09-03T14:20:00.000-08:00",
    vehicles: [record()],
  };

  it("accepts a bundle that has been through a file", () => {
    const parsed: unknown = JSON.parse(JSON.stringify(bundle));
    expect(exportBundleSchema.parse(parsed)).toEqual(bundle);
  });

  it("accepts an empty bundle", () => {
    expect(exportBundleSchema.safeParse({ ...bundle, vehicles: [] }).success).toBe(true);
  });

  it("refuses another app's file, another bundle version and a missing list", () => {
    expect(exportBundleSchema.safeParse({ ...bundle, app: "vin-scanner" }).success).toBe(false);
    expect(exportBundleSchema.safeParse({ ...bundle, v: 2 }).success).toBe(false);
    expect(exportBundleSchema.safeParse({ ...bundle, exportedAt: "today" }).success).toBe(false);
    expect(exportBundleSchema.safeParse(without(bundle, "vehicles")).success).toBe(false);
  });

  it("refuses a bundle carrying one bad record, so a half-import cannot happen", () => {
    const mixed = { ...bundle, vehicles: [record(), { vin: VIN }] };
    expect(exportBundleSchema.safeParse(mixed).success).toBe(false);
  });
});
