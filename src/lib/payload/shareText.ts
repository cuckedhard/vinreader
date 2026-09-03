/**
 * §4.9 share text — the human-readable block Web Share sends alongside the JSON file.
 * Pure: no DOM, no React, no I/O, and no clock (P3); the scan time comes off the record.
 */
import { groupVin } from "../vin/grammar";
import type { VehicleRecord } from "../vin/types";

/** vPIC returns every value as a string and an empty one means unknown (§4.7). */
function text(fields: Record<string, string>, key: string): string {
  return (fields[key] ?? "").trim();
}

function join(parts: readonly string[], separator: string): string {
  return parts.filter((part) => part !== "").join(separator);
}

/**
 * §5.1 timestamps carry their own UTC offset, and §4.9 prints the wall clock the scan
 * actually happened at. The date and time components of an ISO 8601 string with an offset
 * are already local to that offset, so reading them off literally keeps the scan on its own
 * day and hour; parsing to an instant and re-rendering would move it into the reader's zone.
 */
const ISO_LOCAL_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/;

function scannedAt(iso: string): string {
  const match = ISO_LOCAL_RE.exec(iso);
  return match === null ? "" : `${match[1]} ${match[2]}`;
}

/** vPIC's `ModelYear`, else the structural year — but only once it is resolved (N2). */
function modelYear(record: VehicleRecord): string {
  const decoded = text(record.decode.fields, "ModelYear");
  if (decoded !== "") return decoded;
  const resolved = record.structural.modelYear.resolved;
  return resolved === null ? "" : String(resolved);
}

/** §4.8 plant: city, state, country, skipping the parts vPIC left empty. */
function plant(record: VehicleRecord): string {
  const fields = record.decode.fields;
  return join(
    [text(fields, "PlantCity"), text(fields, "PlantState"), text(fields, "PlantCountry")],
    ", ",
  );
}

/**
 * §4.9 fixes this block verbatim and its last line ends at "VIN Relay", so the sender's
 * device label rides in the payload's `by` field rather than in the readable text. It is
 * deliberately not a parameter here: one that was accepted and ignored would read as a bug.
 */
export function shareText(record: VehicleRecord): string {
  const fields = record.decode.fields;
  const body = text(fields, "BodyClass");
  const engine = text(fields, "EngineModel");
  const gvwr = text(fields, "GVWR");
  const unit = (record.unit ?? "").trim();
  const scanned = scannedAt(record.lastScannedAt);
  const plantText = plant(record);

  const lines = [
    join([modelYear(record), text(fields, "Make"), text(fields, "Model")], " ") +
      (body === "" ? "" : ` (${body})`),
    `VIN ${groupVin(record.vin)}`,
    join(
      [
        engine === "" ? "" : `Engine ${engine}`,
        text(fields, "FuelTypePrimary"),
        text(fields, "DriveType"),
        gvwr === "" ? "" : `GVWR ${gvwr}`,
      ],
      " · ",
    ),
    plantText === "" ? "" : `Plant: ${plantText}`,
    join(
      [unit === "" ? "" : `Unit ${unit}`, scanned === "" ? "" : `Scanned ${scanned}`, "VIN Relay"],
      " · ",
    ),
  ];

  // §4.9: rows with no data are omitted entirely.
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}
