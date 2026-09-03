import { describe, expect, it } from "vitest";
import { buildStructural } from "../vin/structural";
import type { VehicleDecode, VehicleRecord } from "../vin/types";
import { META_NEVER_EDITED } from "../vin/types";
import { CSV_COLUMNS, buildExportBundle, toCsv } from "./exportBundle";

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
    decode: decode({
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
    }),
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

/**
 * A minimal RFC 4180 reader, written here so the assertions are about what a spreadsheet
 * would parse back rather than about a literal string. Handles quoted fields, doubled
 * quotes inside them, and CRLF or LF record separators.
 */
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i += 2;
      } else if (c === '"') {
        quoted = false;
        i += 1;
      } else {
        field += c;
        i += 1;
      }
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      i += 1;
    } else if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
    } else if (c === "\r" || c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += c === "\r" && input[i + 1] === "\n" ? 2 : 1;
    } else {
      field += c;
      i += 1;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function cell(csv: string, column: (typeof CSV_COLUMNS)[number]): string {
  const rows = parseCsv(csv);
  return rows[1][CSV_COLUMNS.indexOf(column)];
}

describe("parseCsv — the reader the assertions lean on", () => {
  it("reads quoted fields, doubled quotes and both record separators", () => {
    expect(parseCsv('a,"b,c","d""e"\r\nf,,g\r\n')).toEqual([
      ["a", "b,c", 'd"e'],
      ["f", "", "g"],
    ]);
    expect(parseCsv('"line\r\nbreak",x\n')).toEqual([["line\r\nbreak", "x"]]);
  });
});

describe("buildExportBundle", () => {
  it("is the §9-S3 shape, exportedAt verbatim", () => {
    const records = [makeRecord()];
    expect(buildExportBundle(records, "2026-09-03T14:20:00-08:00")).toEqual({
      app: "vin-relay",
      v: 1,
      exportedAt: "2026-09-03T14:20:00-08:00",
      vehicles: records,
    });
  });

  it("carries an empty list through", () => {
    expect(buildExportBundle([], AT).vehicles).toEqual([]);
  });

  it("does not alias the caller's array", () => {
    const records = [makeRecord()];
    const bundle = buildExportBundle(records, AT);
    records.push(makeRecord({ vin: OTHER_VIN }));
    expect(bundle.vehicles).toHaveLength(1);
  });
});

describe("toCsv — header and columns", () => {
  it("emits the §9-S3 header exactly, in order", () => {
    expect(parseCsv(toCsv([]))[0]).toEqual([...CSV_COLUMNS]);
  });

  it("emits just the header for an empty list", () => {
    expect(parseCsv(toCsv([]))).toHaveLength(1);
    expect(toCsv([])).toBe(`${CSV_COLUMNS.join(",")}\r\n`);
  });

  it("uses CRLF, which is what Excel expects", () => {
    expect(toCsv([makeRecord()])).toContain("\r\n");
    expect(
      toCsv([makeRecord()])
        .split("\r\n")
        .filter((line) => line !== ""),
    ).toHaveLength(2);
  });

  it("writes one row per record, every column filled from the record", () => {
    const rows = parseCsv(toCsv([makeRecord({ notes: "left rear door" })]));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveLength(CSV_COLUMNS.length);
    expect(rows[1]).toEqual([
      VIN,
      "2003",
      "HONDA",
      "Accord",
      "EX",
      "Sedan/Saloon",
      "J30A4",
      "Gasoline",
      "FWD",
      "Class 1C: 4,001 - 5,000 lb",
      "MARYSVILLE, OHIO, UNITED STATES (USA)",
      "UNIT-42",
      "left rear door",
      AT,
      AT,
      "3",
      "ok",
    ]);
  });

  it("leaves unknown vPIC values empty and falls back to the structural year", () => {
    const record = makeRecord({ decode: { ...decode({}), status: "pending" }, unit: null });
    const csv = toCsv([record]);
    expect(cell(csv, "year")).toBe("2003");
    expect(cell(csv, "make")).toBe("");
    expect(cell(csv, "plant")).toBe("");
    expect(cell(csv, "unit")).toBe("");
    expect(cell(csv, "notes")).toBe("");
    expect(cell(csv, "decodeStatus")).toBe("pending");
  });

  it("leaves the year empty rather than guessing between two candidates (N2)", () => {
    const record = makeRecord({
      decode: decode({}),
      structural: {
        ...buildStructural(VIN, 2026),
        modelYear: { candidates: [2003, 2033], resolved: null },
      },
    });
    expect(cell(toCsv([record]), "year")).toBe("");
  });

  it("writes one row per record for many records", () => {
    const rows = parseCsv(toCsv([makeRecord(), makeRecord({ vin: OTHER_VIN })]));
    expect(rows.map((row) => row[0])).toEqual(["vin", VIN, OTHER_VIN]);
  });
});

describe("toCsv — a note cannot corrupt the file", () => {
  const cases: Array<[string, string]> = [
    ["a comma", "rear bumper, cracked"],
    ["a double quote", 'driver said "it rattles"'],
    ["a quote at the start", '"quoted" note'],
    ["a newline", "line one\nline two"],
    ["a CRLF", "line one\r\nline two"],
    ["a delimiter and a quote together", 'a,b,"c"'],
  ];

  for (const [name, notes] of cases) {
    it(`round-trips a note containing ${name}`, () => {
      const rows = parseCsv(toCsv([makeRecord({ notes })]));
      expect(rows).toHaveLength(2);
      expect(rows[1]).toHaveLength(CSV_COLUMNS.length);
      expect(rows[1][CSV_COLUMNS.indexOf("notes")]).toBe(notes);
      // The row is still a row: the columns after notes did not shift.
      expect(rows[1][CSV_COLUMNS.indexOf("scanCount")]).toBe("3");
    });
  }

  it("neutralises a note that would be read as a formula, and stays parseable", () => {
    const notes = '=HYPERLINK("http://evil","click"),1';
    const rows = parseCsv(toCsv([makeRecord({ notes })]));
    expect(rows).toHaveLength(2);
    expect(rows[1][CSV_COLUMNS.indexOf("notes")]).toBe(`'${notes}`);
  });

  for (const lead of ["=", "+", "-", "@"]) {
    it(`prefixes a value opening with "${lead}"`, () => {
      const csv = toCsv([makeRecord({ notes: `${lead}1+1`, unit: `${lead}UNIT` })]);
      expect(cell(csv, "notes")).toBe(`'${lead}1+1`);
      expect(cell(csv, "unit")).toBe(`'${lead}UNIT`);
    });
  }

  it("leaves an ordinary value untouched", () => {
    const csv = toCsv([makeRecord({ notes: "fleet 12" })]);
    expect(csv).toContain("fleet 12");
    expect(cell(csv, "notes")).toBe("fleet 12");
  });
});
