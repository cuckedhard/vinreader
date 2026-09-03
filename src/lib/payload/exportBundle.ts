/**
 * §9-S3 "Export all": the JSON bundle and the CSV. Pure: no DOM, no React, no I/O and no
 * clock (P3) — `exportedAt` is an argument.
 */
import type { VehicleRecord } from "../vin/types";
import type { ExportBundle } from "./schema";

export function buildExportBundle(records: VehicleRecord[], exportedAt: string): ExportBundle {
  // Copied so a later mutation of the caller's array cannot rewrite a bundle already built.
  return { app: "vin-relay", v: 1, exportedAt, vehicles: [...records] };
}

/** §9-S3, in this order. Also the column order of §6.5 "Copy row". */
export const CSV_COLUMNS = [
  "vin",
  "year",
  "make",
  "model",
  "trim",
  "body",
  "engine",
  "fuel",
  "drive",
  "gvwr",
  "plant",
  "unit",
  "notes",
  "firstScannedAt",
  "lastScannedAt",
  "scanCount",
  "decodeStatus",
] as const;

function text(fields: Record<string, string>, key: string): string {
  return (fields[key] ?? "").trim();
}

/**
 * Same two derivations `shareText` makes, kept local so each file's export surface stays
 * exactly what §S3 fixes: vPIC's `ModelYear` else the structural year once resolved (N2),
 * and §4.8 plant as city, state, country with the empty parts skipped.
 */
function modelYear(record: VehicleRecord): string {
  const decoded = text(record.decode.fields, "ModelYear");
  if (decoded !== "") return decoded;
  const resolved = record.structural.modelYear.resolved;
  return resolved === null ? "" : String(resolved);
}

function plant(record: VehicleRecord): string {
  const fields = record.decode.fields;
  return [text(fields, "PlantCity"), text(fields, "PlantState"), text(fields, "PlantCountry")]
    .filter((part) => part !== "")
    .join(", ");
}

/** One row, in `CSV_COLUMNS` order. */
function csvRow(record: VehicleRecord): string[] {
  const fields = record.decode.fields;
  return [
    record.vin,
    modelYear(record),
    text(fields, "Make"),
    text(fields, "Model"),
    text(fields, "Trim"),
    text(fields, "BodyClass"),
    text(fields, "EngineModel"),
    text(fields, "FuelTypePrimary"),
    text(fields, "DriveType"),
    text(fields, "GVWR"),
    plant(record),
    record.unit ?? "",
    record.notes ?? "",
    record.firstScannedAt,
    record.lastScannedAt,
    String(record.scanCount),
    record.decode.status,
  ];
}

/** RFC 4180: a field carrying a delimiter, a quote or a line break must be quoted. */
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * Excel and Google Sheets read a cell opening with `=`, `+`, `-` or `@` as a formula, so a
 * note pasted from a work order could execute on open. The leading apostrophe is the
 * spreadsheet's own literal marker and is not part of the imported value.
 */
const FORMULA_LEAD = /^[=+\-@]/;

function csvField(value: string): string {
  const guarded = FORMULA_LEAD.test(value) ? `'${value}` : value;
  // An embedded quote is escaped by doubling it (RFC 4180).
  return NEEDS_QUOTING.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** Header plus one row per record. CRLF because that is what Excel expects. */
export function toCsv(records: VehicleRecord[]): string {
  const lines = [CSV_COLUMNS.map(csvField).join(",")];
  for (const record of records) lines.push(csvRow(record).map(csvField).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
