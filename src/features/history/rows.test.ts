import { describe, expect, it } from "vitest";
import { CSV_COLUMNS, toCsv } from "../../lib/payload/exportBundle";
import { buildStructural } from "../../lib/vin/structural";
import { META_NEVER_EDITED } from "../../lib/vin/types";
import type { VehicleDecode, VehicleRecord } from "../../lib/vin/types";
import { toTsv, toTsvRow, tsvLines } from "./rows";

const VIN = "1HGCM82633A004352";
const OTHER_VIN = "1HGCM826X3A004350";
const AT = "2026-09-03T14:12:00-08:00";

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

function makeRecord(overrides: Partial<VehicleRecord> = {}): VehicleRecord {
  return {
    vin: VIN,
    structural: buildStructural(VIN, 2026),
    decode: decode({ ModelYear: "2003", Make: "HONDA", Model: "Accord" }),
    unit: "UNIT-42",
    notes: null,
    firstScannedAt: AT,
    lastScannedAt: AT,
    scanCount: 3,
    origin: "scan",
    metaUpdatedAt: META_NEVER_EDITED,
    deletedAt: null,
    ...overrides,
  };
}

describe("toTsv", () => {
  it("leads with the S3 column order, so TSV and CSV cannot describe different columns", () => {
    expect(tsvLines([])).toEqual([CSV_COLUMNS.join("\t")]);
    expect(toTsv([])).toBe(CSV_COLUMNS.join("\t"));
  });

  it("writes one line per record and one cell per column", () => {
    const lines = toTsv([makeRecord(), makeRecord({ vin: OTHER_VIN })]).split("\r\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line.split("\t")).toHaveLength(CSV_COLUMNS.length);
    expect(lines[1].split("\t").slice(0, 4)).toEqual([VIN, "2003", "HONDA", "Accord"]);
    expect(lines[2].split("\t")[0]).toBe(OTHER_VIN);
  });

  it("ends without a terminator, so a paste does not land an empty row in the grid", () => {
    expect(toTsv([makeRecord()]).endsWith("\r\n")).toBe(false);
    // The CSV file it is derived from keeps its RFC 4180 terminator.
    expect(toCsv([makeRecord()]).endsWith("\r\n")).toBe(true);
  });

  it("undoes the CSV quoting rather than pasting quotes into the cells", () => {
    const line = toTsv([makeRecord({ notes: 'Left "front" axle, seized' })]).split("\r\n")[1];
    const cells = line.split("\t");
    expect(cells).toHaveLength(CSV_COLUMNS.length);
    expect(cells[CSV_COLUMNS.indexOf("notes")]).toBe('Left "front" axle, seized');
  });

  it("folds a tab or a line break inside a cell, which TSV has no way to quote", () => {
    const notes = "Line one\r\nline two\tcolumn two";
    const cells = toTsv([makeRecord({ notes })])
      .split("\r\n")[1]
      .split("\t");
    // Without the fold this row would carry three extra cells and one extra line, and
    // every column to its right would be one place out in the spreadsheet.
    expect(cells).toHaveLength(CSV_COLUMNS.length);
    expect(cells[CSV_COLUMNS.indexOf("notes")]).toBe("Line one line two column two");
  });

  it("keeps the spreadsheet formula guard the CSV applies", () => {
    const cells = toTsv([makeRecord({ notes: "=SUM(A1:A9)" })])
      .split("\r\n")[1]
      .split("\t");
    expect(cells[CSV_COLUMNS.indexOf("notes")]).toBe("'=SUM(A1:A9)");
  });

  it("copies the whole selection in the order it was given", () => {
    const lines = toTsv([makeRecord({ vin: OTHER_VIN }), makeRecord()]).split("\r\n");
    expect([lines[1].split("\t")[0], lines[2].split("\t")[0]]).toEqual([OTHER_VIN, VIN]);
  });
});

describe("toTsvRow", () => {
  it("is §6.5's Row: one line, no header, same columns", () => {
    const record = makeRecord();
    const row = toTsvRow(record);
    expect(row.split("\t")).toHaveLength(CSV_COLUMNS.length);
    expect(row.startsWith(`${VIN}\t`)).toBe(true);
    expect(row).toBe(toTsv([record]).split("\r\n")[1]);
    expect(row.includes(CSV_COLUMNS.join("\t"))).toBe(false);
  });
});
