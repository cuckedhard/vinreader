/**
 * §5.3 upsert — keyed by VIN, idempotent, never duplicates (P4).
 *
 * Local writes only. `origin: "cloud"` is deliberately not accepted (D12): the S4 pull
 * path applies server rows through its own apply path, because routing them here would
 * inflate `scanCount` on every pull and fabricate scan events.
 */
import { buildStructural } from "../vin/structural";
import type { ScanEvent, Symbology, VehicleDecode, VehicleRecord } from "../vin/types";
import { META_NEVER_EDITED } from "../vin/types";
import { db, nowIso } from "./db";

export type UpsertInput = {
  vin: string;
  origin: "scan" | "manual" | "import";
  symbology: Symbology;
  raw: string;
  checkDigitValid: boolean;
  at?: string;
  deviceLabel?: string | null;
  unit?: string | null;
  notes?: string | null;
};

/** §5.1: every S0 record starts pending; S2 fills it in. */
/** §5.1: the decode block every record starts with. Exported so the sync-shape
 * normaliser builds from the same default rather than restating it (§7 item 5). */
export function pendingDecode(): VehicleDecode {
  return {
    status: "pending",
    source: "nhtsa_vpic",
    fetchedAt: null,
    attempts: 0,
    lastError: null,
    fields: {},
  };
}

/** A value counts as incoming only when it carries text; whitespace is not an edit. */
function meaningful(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Offset timestamps do not sort as strings (§5.1), so compare by instant. */
function instant(iso: string): number {
  return Date.parse(iso);
}

export async function upsertVehicle(input: UpsertInput): Promise<VehicleRecord> {
  const at = input.at ?? nowIso();
  const incomingUnit = meaningful(input.unit);
  const incomingNotes = meaningful(input.notes);
  const currentYear = new Date().getFullYear();

  return db.transaction("rw", db.vehicles, db.scanEvents, async () => {
    const existing = await db.vehicles.get(input.vin);
    const unit = incomingUnit ?? existing?.unit ?? null;
    const notes = incomingNotes ?? existing?.notes ?? null;
    // D11: the LWW clock moves only when this write actually lands unit or notes — a
    // user edit, or an import carrying them. A plain re-scan must leave it alone, or a
    // scan on one device silently wipes an earlier real edit made on another (§4.12).
    const metaChanged = unit !== (existing?.unit ?? null) || notes !== (existing?.notes ?? null);

    const record: VehicleRecord = {
      vin: input.vin,
      // Derived from the 17 characters alone, so it is recomputed on every write and a
      // record stored before a constants fix heals itself.
      structural: buildStructural(input.vin, currentYear),
      // §5.3 keeps an existing decode of ok / partial / unsupported and otherwise takes
      // the incoming one if better. Nothing here ever carries a decode — every write
      // starts pending, the lowest rank (§4.12) — so keeping the existing block is that
      // rule in full. The rank merge lands in S2, where real decodes arrive.
      decode: existing?.decode ?? pendingDecode(),
      unit,
      notes,
      // §4.12 aggregates: first = min, last = max. An import may carry an older `at`.
      firstScannedAt:
        existing && instant(existing.firstScannedAt) < instant(at) ? existing.firstScannedAt : at,
      lastScannedAt:
        existing && instant(existing.lastScannedAt) > instant(at) ? existing.lastScannedAt : at,
      scanCount: (existing?.scanCount ?? 0) + 1,
      // How the record first entered this device; a re-scan does not rewrite provenance.
      origin: existing?.origin ?? input.origin,
      metaUpdatedAt: metaChanged ? nowIso() : (existing?.metaUpdatedAt ?? META_NEVER_EDITED),
      // §4.12: any later scan event clears the tombstone.
      deletedAt: null,
    };

    const event: ScanEvent = {
      id: crypto.randomUUID(),
      vin: input.vin,
      at,
      symbology: input.symbology,
      raw: input.raw,
      checkDigitValid: input.checkDigitValid,
      deviceLabel: input.deviceLabel ?? null,
    };

    await db.vehicles.put(record);
    await db.scanEvents.add(event);
    return record;
  });
}

/**
 * The only path that moves `metaUpdatedAt` off the epoch by hand: a user edit to unit or
 * notes, stamped with the device clock (D11, §4.12). An explicit `null` or empty string
 * clears the field; `undefined` leaves it as it was.
 */
export async function setVehicleMeta(
  vin: string,
  patch: { unit?: string | null; notes?: string | null },
): Promise<VehicleRecord> {
  return db.transaction("rw", db.vehicles, async () => {
    const existing = await db.vehicles.get(vin);
    if (!existing) throw new Error(`setVehicleMeta: no record for VIN ${vin}`);
    const next: VehicleRecord = {
      ...existing,
      unit: patch.unit === undefined ? existing.unit : meaningful(patch.unit),
      notes: patch.notes === undefined ? existing.notes : meaningful(patch.notes),
      metaUpdatedAt: nowIso(),
    };
    await db.vehicles.put(next);
    return next;
  });
}
