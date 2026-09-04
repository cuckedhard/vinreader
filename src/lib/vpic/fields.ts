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

/**
 * §4.8: group titles, row order and vPIC keys are authoritative (P2). Every key below is
 * §4.8 verbatim except the Cab row, corrected under §4.8's own standing instruction to
 * "verify every key against a live call ... and correct any that differ" — see there.
 */
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
      // §4.8 prints this key as `CabType`. `DecodeVinValues` carries no such key: vPIC's
      // variable "Cab Type" (`Element` id 4, lookup `BodyCab`) emits `BodyCabType`, and it is
      // a medium/heavy-duty truck field — Cab Over Engine, Conventional, Low Cab Forward.
      // Reading a key that can never arrive made the row permanently empty, and N2 drops an
      // empty row, so the sheet showed nothing rather than an error. Corrected per §4.8;
      // the label is §4.8's and does not change (R4-K). Pinned in `DECODE_VIN_VALUES_KEYS`.
      plain("Cab", "BodyCabType"),
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

/**
 * The key space of a `DecodeVinValues` `Results[0]` row: a **recorded snapshot of key names**,
 * captured 2026-09-04. Names only — no values, no vehicle data, nothing that could be mistaken
 * for a decode (N2: never show a guess as a fact; this list cannot fill a sheet).
 *
 * Provenance — two independent sources, which agree on all 150 names:
 *  1. `@shaggytools/nhtsa-api-wrapper@3.0.4`, whose
 *     `dist/types/api/endpoints/DecodeVinValues.d.ts` declares `DecodeVinValuesResults` as exactly
 *     150 `string` members. Re-derive with:
 *       npm pack @shaggytools/nhtsa-api-wrapper && tar xzf *.tgz
 *       awk '/^export type DecodeVinValuesResults = \{/,/^\};/' \
 *         package/dist/types/api/endpoints/DecodeVinValues.d.ts |
 *         grep -oP '^\s{4}\K[A-Za-z_0-9]+(?=: string;)'
 *  2. vPIC's own `Element` table (mirrored offline in `@cardog/corgi@2.0.4`,
 *     `dist/db/vpic.lite.db`), whose `Code` column is the flat key each variable emits —
 *     `select Code from Element where Name = 'Cab Type'` → `BodyCabType`. 146 of the 150 names
 *     below are `Element.Code` values; the other four (`VIN`, `MakeID`, `ModelID`,
 *     `ManufacturerId`) are API-level rather than variable-level.
 *
 * This is a snapshot, not a live call, and it does not discharge the §9-S2 duty to run
 * `scripts/verify-vpic-fields.ts` where vPIC is reachable. What it does is give the map something
 * to be checked against other than a hand-copy of §4.8 — which is exactly how `CabType` survived
 * S2 and four hardening rounds: the map and the test's own literal agreed with each other, and
 * both were wrong. The check is a subset (§4.8's keys ⊆ this list), so a variable NHTSA adds later
 * is not a failure and this list needs no upkeep; a key it stops carrying is the alarm we want.
 */
export const DECODE_VIN_VALUES_KEYS: readonly string[] = `
  ABS ActiveSafetySysNote AdaptiveCruiseControl AdaptiveDrivingBeam AdaptiveHeadlights
  AdditionalErrorText AirBagLocCurtain AirBagLocFront AirBagLocKnee AirBagLocSeatCushion
  AirBagLocSide AutoReverseSystem AutomaticPedestrianAlertingSound AxleConfiguration Axles
  BasePrice BatteryA BatteryA_to BatteryCells BatteryInfo BatteryKWh BatteryKWh_to
  BatteryModules BatteryPacks BatteryType BatteryV BatteryV_to BedLengthIN BedType
  BlindSpotIntervention BlindSpotMon BodyCabType BodyClass BrakeSystemDesc BrakeSystemType
  BusFloorConfigType BusLength BusType CAN_AACN CIB CashForClunkers ChargerLevel ChargerPowerKW
  CoolingType CurbWeightLB CustomMotorcycleType DaytimeRunningLight DestinationMarket
  DisplacementCC DisplacementCI DisplacementL Doors DriveType DriverAssist DynamicBrakeSupport
  EDR ESC EVDriveUnit ElectrificationLevel EngineConfiguration EngineCycles EngineCylinders
  EngineHP EngineHP_to EngineKW EngineManufacturer EngineModel EntertainmentSystem ErrorCode
  ErrorText ForwardCollisionWarning FuelInjectionType FuelTypePrimary FuelTypeSecondary GCWR
  GCWR_to GVWR GVWR_to KeylessIgnition LaneCenteringAssistance LaneDepartureWarning
  LaneKeepSystem LowerBeamHeadlampLightSource Make MakeID Manufacturer ManufacturerId Model
  ModelID ModelYear MotorcycleChassisType MotorcycleSuspensionType NCSABodyType NCSAMake
  NCSAMapExcApprovedBy NCSAMapExcApprovedOn NCSAMappingException NCSAModel NCSANote NonLandUse
  Note OtherBusInfo OtherEngineInfo OtherMotorcycleInfo OtherRestraintSystemInfo
  OtherTrailerInfo ParkAssist PedestrianAutomaticEmergencyBraking PlantCity PlantCompanyName
  PlantCountry PlantState PossibleValues Pretensioner RearAutomaticEmergencyBraking
  RearCrossTrafficAlert RearVisibilitySystem SAEAutomationLevel SAEAutomationLevel_to
  SeatBeltsAll SeatRows Seats SemiautomaticHeadlampBeamSwitching Series Series2
  SteeringLocation SuggestedVIN TPMS TopSpeedMPH TrackWidth TractionControl TrailerBodyType
  TrailerLength TrailerType TransmissionSpeeds TransmissionStyle Trim Trim2 Turbo VIN
  ValveTrainDesign VehicleDescriptor VehicleType WheelBaseLong WheelBaseShort WheelBaseType
  WheelSizeFront WheelSizeRear Wheels Windows
`
  .trim()
  .split(/\s+/);

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
  // `Object.entries` never repeats a key, so the comparator needs no equal case.
  return Object.entries(fields)
    .map(([key, value]) => ({ label: key, value }))
    .sort((a, b) => (a.label < b.label ? -1 : 1));
}
