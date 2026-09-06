/**
 * The Sheet's copy strings, and the two things about them that can break silently.
 *
 * 1. **§6.5's "Row" is the S3 CSV column order.** Nothing on screen shows a header, so a
 *    column that moved would paste into the wrong spreadsheet column and look plausible.
 *    Every assertion below indexes `CSV_COLUMNS` by name rather than by a literal position,
 *    so this file agrees with `src/lib/payload/exportBundle.ts` by construction (§7 item 5)
 *    and still fails if the Sheet stops using it.
 * 2. **§6.5's synchronous-clipboard rule.** This suite runs in vitest's node environment,
 *    where there is no `window`, no `document` and no Dexie handle in scope — so the fact
 *    that `buildCopyTexts` returns every string from `(record, deviceLabel, origin)` alone
 *    is what makes it pass at all. An `await` added ahead of the clipboard write is the one
 *    §11 defect that passes every test in this repo; a builder that cannot reach the
 *    document is the part of it that can be pinned here.
 */
import { describe, expect, it } from "vitest";
import { CSV_COLUMNS } from "../../lib/payload/exportBundle";
import { shareText } from "../../lib/payload/shareText";
import { buildStructural } from "../../lib/vin/structural";
import { META_NEVER_EDITED } from "../../lib/vin/types";
import type { VehicleDecode, VehicleRecord } from "../../lib/vin/types";
import { buildCopyTexts } from "./copyTexts";

/** §4.11's fixture VIN. */
const VIN = "1HGCM82633A004352";
const AT = "2026-09-03T14:12:00-08:00";
const ORIGIN = "https://vinrelay.example";
const DEVICE = "Zach's iPhone";

function decode(): VehicleDecode {
  return {
    status: "ok",
    source: "nhtsa_vpic",
    fetchedAt: AT,
    attempts: 1,
    lastError: null,
    fields: {
      ModelYear: "2003",
      Make: "HONDA",
      Model: "Accord",
      Trim: "EX",
      BodyClass: "Sedan/Saloon",
      EngineModel: "J30A4",
      FuelTypePrimary: "Gasoline",
      DriveType: "FWD",
      GVWR: "Class 1C: 4,001 - 5,000 lb",
      PlantCity: "MARYSVILLE",
      PlantState: "OHIO",
      PlantCountry: "UNITED STATES (USA)",
    },
  };
}

function makeRecord(overrides: Partial<VehicleRecord> = {}): VehicleRecord {
  return {
    vin: VIN,
    structural: buildStructural(VIN, 2026),
    decode: decode(),
    unit: "UNIT-42",
    notes: null,
    paint: null,
    firstScannedAt: AT,
    lastScannedAt: AT,
    scanCount: 3,
    origin: "scan",
    metaUpdatedAt: META_NEVER_EDITED,
    deletedAt: null,
    ...overrides,
  };
}

function cells(row: string): string[] {
  return row.split("\t");
}

function cell(row: string, column: (typeof CSV_COLUMNS)[number]): string {
  return cells(row)[CSV_COLUMNS.indexOf(column)];
}

describe("§6.5 Copy row", () => {
  it("is one tab-separated line in the S3 CSV column order", () => {
    const { row } = buildCopyTexts(makeRecord(), DEVICE, ORIGIN);

    expect(cells(row)).toHaveLength(CSV_COLUMNS.length);
    expect(cell(row, "vin")).toBe(VIN);
    expect(cell(row, "year")).toBe("2003");
    expect(cell(row, "make")).toBe("HONDA");
    expect(cell(row, "model")).toBe("Accord");
    expect(cell(row, "gvwr")).toBe("Class 1C: 4,001 - 5,000 lb");
    expect(cell(row, "plant")).toBe("MARYSVILLE, OHIO, UNITED STATES (USA)");
    expect(cell(row, "unit")).toBe("UNIT-42");
    expect(cell(row, "scanCount")).toBe("3");
    expect(cell(row, "decodeStatus")).toBe("ok");
  });

  it("carries no header — the row is one record, not a one-record export", () => {
    const { row } = buildCopyTexts(makeRecord(), DEVICE, ORIGIN);
    expect(row).not.toContain(CSV_COLUMNS.join("\t"));
    expect(row).not.toContain("\r");
    expect(row).not.toContain("\n");
  });

  it("keeps a note with tabs and line breaks inside its own cell", () => {
    // Otherwise every column to the right of `notes` shifts by one on paste, in a
    // spreadsheet, silently — TSV has no quoting to say the break was content.
    const record = makeRecord({ notes: "left\tright\nsecond line" });
    const { row } = buildCopyTexts(record, DEVICE, ORIGIN);

    expect(cells(row)).toHaveLength(CSV_COLUMNS.length);
    expect(cell(row, "notes")).toBe("left right second line");
    expect(cell(row, "decodeStatus")).toBe("ok");
  });

  it("leaves an unknown field empty rather than writing a placeholder (N2)", () => {
    const record = makeRecord({ decode: { ...decode(), fields: {} }, unit: null });
    const { row } = buildCopyTexts(record, DEVICE, ORIGIN);

    expect(cell(row, "make")).toBe("");
    expect(cell(row, "unit")).toBe("");
    // §4.4: with no vPIC year the structural resolution is the honest answer.
    expect(cell(row, "year")).toBe("2003");
  });
});

describe("the other four copy formats", () => {
  const texts = buildCopyTexts(makeRecord(), DEVICE, ORIGIN);

  it("copies the VIN as 17 bare characters, not the grouped display form", () => {
    expect(texts.vin).toBe(VIN);
    expect(texts.vin).toHaveLength(17);
    expect(texts.vin).not.toContain(" ");
  });

  it("copies §4.9's share text as the summary", () => {
    expect(texts.summary).toBe(shareText(makeRecord()));
  });

  it("copies the §4.9 text carrier as the link, which is what another VIN Relay imports", () => {
    expect(texts.link.startsWith("VINRELAY1:")).toBe(true);
  });

  it("copies the record itself as JSON", () => {
    expect(JSON.parse(texts.json)).toEqual(makeRecord());
  });

  it("builds the QR's URL carrier on the origin it is given, in the fragment", () => {
    expect(texts.url.startsWith(`${ORIGIN}/#/i?d=`)).toBe(true);
    expect(texts.dropped).toEqual([]);
  });
});
