/**
 * §4.9 share text — the human-readable block Web Share sends alongside the JSON file.
 * Pure: no DOM, no React, no I/O, and no clock (P3); the scan time comes off the record.
 */
import { groupVin, isVinGrammarValid } from "../vin/grammar";
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

/**
 * §4.9's VIN line, read back. `\s` rather than a literal space so a block that has been
 * through a mail client or a messaging app — non-breaking spaces, a tab — is still this
 * app's own format. The label is matched case-insensitively for the reason `carrier.ts`
 * gives for the same choice: recognition is not decoding, and a block mangled in transit
 * still has to reach the parser that knows what it is. The tail of the line is taken whole
 * and greedily — what follows is stripped of whitespace anyway, so there is no trailing
 * `\s*` for a lazy group to backtrack against.
 */
const VIN_LINE_RE = /^\s*VIN\s+(.+)$/i;

const INNER_SPACE_RE = /\s+/g;

/**
 * Reads the VIN back out of a §4.9 share text. Returns null when the text is not one —
 * which is the only case in which a caller may fall through to `extractVin` (§4.2).
 *
 * **Why this exists.** "Copy summary" (§6.5) writes the block above, and pasting it into
 * Import (§6.2) answered NO_VIN: §4.2 step 1 strips whitespace BEFORE step 2 splits into
 * runs, so the label and the §4.1 grouping fuse into `VIN1HGCM82633A004352`, the `I` of
 * the word "VIN" is the only separator, and what is left is an 18-character run with two
 * windows — precisely the shape ledger R4-A now refuses. The app could not read its own
 * output, and the shop that was texted a summary saw the failure microcopy for it.
 *
 * **Why a parser and not a looser §4.2.** Neither §4-level alternative even works here,
 * measured on all three shapes `shareText` can emit: treating whitespace as a separator
 * instead of stripping it shatters the grouped VIN into six runs, none of them 17
 * characters long, so the round trip stays NO_VIN — and it would cost §4.2 a covered case
 * on real labels. This is our own format with a known shape, so it is parsed as one, the
 * same argument §4.9's carrier guard already makes: what this app wrote gets read by the
 * code that knows the format, and only unknown bytes are mined for a VIN (D14).
 *
 * **Why it cannot fabricate.** No window slides here. The VIN is the ENTIRE content of a
 * line whose label says it is a VIN, so a line carrying anything else beside it — the
 * straddle case §4.2 refuses — collapses to something that is not 17 §4.1 characters and
 * is refused too. Two different labelled VINs are ambiguous and yield null rather than a
 * choice (N2), by the same argument as §4.2 step 4(a)'s uniqueness; the same VIN labelled
 * twice is one answer, not two. §4.3 is not consulted: a check digit that does not match
 * is shown and never enforced (D17), exactly as on every other import path.
 */
export function parseShareTextVin(raw: string): string | null {
  const found = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = VIN_LINE_RE.exec(line);
    if (match === null) continue;
    // §4.1 grouping is display-only, so the groups close back up; uppercased because a
    // client that lower-cased the block still holds this app's VIN.
    const candidate = match[1].replace(INNER_SPACE_RE, "").toUpperCase();
    if (isVinGrammarValid(candidate)) found.add(candidate);
  }
  return found.size === 1 ? [...found][0]! : null;
}
