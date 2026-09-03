/**
 * §4.8 display field map, held as data. §9-S2 requires the map to live here rather than
 * scattered through JSX, so the sheet renders whatever this file says and nothing else.
 * Pure: no DOM, no React, no I/O.
 *
 * Every value vPIC returns is a string and an empty string means unknown (§4.7), so a row
 * whose value comes out empty is never rendered and a group with no rows disappears (N2).
 */

export interface FieldRow {
  label: string;
  value: string;
}

export interface RenderedGroup {
  title: string;
  rows: FieldRow[];
}

/** `Results[0]` with empty values removed, i.e. `VehicleDecode.fields`. */
type Fields = Record<string, string>;

interface FieldSpec {
  readonly label: string;
  /** Every vPIC key this row reads. Feeds `MAPPED_KEYS`, which the live check gates on. */
  readonly keys: readonly string[];
  readonly render: (fields: Fields) => string;
}

interface GroupSpec {
  readonly title: string;
  readonly rows: readonly FieldSpec[];
}

/** Tolerates a missing key and whitespace-only padding; both mean unknown. */
function text(fields: Fields, key: string): string {
  return (fields[key] ?? "").trim();
}

function joinParts(parts: readonly string[], separator: string): string {
  return parts.filter((part) => part.length > 0).join(separator);
}

/** A row that shows one key verbatim. */
function plain(label: string, key: string): FieldSpec {
  return { label, keys: [key], render: (fields) => text(fields, key) };
}

/** Fuel — `FuelTypePrimary` (+ `FuelTypeSecondary` if present), joined with " / ". */
const FUEL: FieldSpec = {
  label: "Fuel",
  keys: ["FuelTypePrimary", "FuelTypeSecondary"],
  render: (fields) =>
    joinParts([text(fields, "FuelTypePrimary"), text(fields, "FuelTypeSecondary")], " / "),
};

/** Transmission — `TransmissionStyle` (+ `TransmissionSpeeds` as "N-speed"), joined with ", ". */
const TRANSMISSION: FieldSpec = {
  label: "Transmission",
  keys: ["TransmissionStyle", "TransmissionSpeeds"],
  render: (fields) => {
    const speeds = text(fields, "TransmissionSpeeds");
    const style = text(fields, "TransmissionStyle");
    return joinParts([style, speeds === "" ? "" : `${speeds}-speed`], ", ");
  },
};

/**
 * GVWR — plain `GVWR`, or a range when `GVWR_to` is present and different.
 * The separator is a spaced en dash because vPIC's own class strings already contain
 * hyphenated ranges ("Class 2E: 6,001 - 7,000 lb"), which a hyphen would blur into.
 */
const GVWR: FieldSpec = {
  label: "GVWR",
  keys: ["GVWR", "GVWR_to"],
  render: (fields) => {
    const from = text(fields, "GVWR");
    const to = text(fields, "GVWR_to");
    if (from === "" || to === "" || to === from) return from;
    return `${from} – ${to}`;
  },
};

/** Bed — `BedType` (+ `BedLengthIN` as "N in"), joined with ", ". */
const BED: FieldSpec = {
  label: "Bed",
  keys: ["BedType", "BedLengthIN"],
  render: (fields) => {
    const length = text(fields, "BedLengthIN");
    return joinParts([text(fields, "BedType"), length === "" ? "" : `${length} in`], ", ");
  },
};

/** Plant — city, state, country joined with ", ", skipping the parts vPIC left empty. */
const PLANT: FieldSpec = {
  label: "Plant",
  keys: ["PlantCity", "PlantState", "PlantCountry"],
  render: (fields) =>
    joinParts(
      [text(fields, "PlantCity"), text(fields, "PlantState"), text(fields, "PlantCountry")],
      ", ",
    ),
};

/** §4.8 verbatim: group titles, row order and vPIC keys are authoritative (P2). */
const GROUPS: readonly GroupSpec[] = [
  {
    title: "Identity",
    rows: [
      plain("Year", "ModelYear"),
      plain("Make", "Make"),
      plain("Model", "Model"),
      plain("Trim", "Trim"),
      plain("Series", "Series"),
      plain("Body", "BodyClass"),
      plain("Type", "VehicleType"),
      plain("Doors", "Doors"),
    ],
  },
  {
    title: "Powertrain",
    rows: [
      plain("Engine", "EngineModel"),
      plain("Cylinders", "EngineCylinders"),
      plain("Displacement (L)", "DisplacementL"),
      FUEL,
      plain("Horsepower", "EngineHP"),
      plain("Turbo", "Turbo"),
      plain("Drive", "DriveType"),
      TRANSMISSION,
    ],
  },
  {
    title: "Weight & class",
    rows: [
      GVWR,
      plain("Axles", "Axles"),
      plain("Brakes", "BrakeSystemType"),
      plain("Cab", "CabType"),
      BED,
    ],
  },
  {
    title: "Manufacturing",
    rows: [
      plain("Manufacturer", "Manufacturer"),
      PLANT,
      plain("Plant company", "PlantCompanyName"),
    ],
  },
];

/** §4.8 notice keys, in the order the sheet shows them. */
export const NOTICE_KEYS: readonly string[] = ["ErrorText", "AdditionalErrorText", "Note"];

/** Every vPIC key §4.8 names, groups first then notices. `scripts/verify-vpic-fields.ts` gates on it. */
export const MAPPED_KEYS: readonly string[] = [
  ...new Set([...GROUPS.flatMap((group) => group.rows.flatMap((row) => row.keys)), ...NOTICE_KEYS]),
];

/** The §4.8 groups that have something to show, in §4.8 order. Empty rows and groups are dropped. */
export function renderGroups(fields: Fields): RenderedGroup[] {
  const rendered: RenderedGroup[] = [];
  for (const group of GROUPS) {
    const rows: FieldRow[] = [];
    for (const spec of group.rows) {
      const value = spec.render(fields);
      if (value !== "") rows.push({ label: spec.label, value });
    }
    if (rows.length > 0) rendered.push({ title: group.title, rows });
  }
  return rendered;
}

/** The notice area: the non-empty `NOTICE_KEYS` values, in that order. */
export function noticeLines(fields: Fields): string[] {
  return NOTICE_KEYS.map((key) => text(fields, key)).filter((line) => line !== "");
}

/**
 * The collapsed "All fields" section: the raw record, every key, sorted by key.
 * Values are untouched and keys the groups already show are not removed.
 * Sorted by code point rather than locale so the order is the same on every device.
 */
export function allFieldRows(fields: Fields): FieldRow[] {
  return Object.keys(fields)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => ({ label: key, value: fields[key] ?? "" }));
}
