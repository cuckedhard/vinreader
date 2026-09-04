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

/**
 * Offset timestamps do not sort as strings (§5.1), so compare by instant. A stored value
 * that is not a string is not a timestamp at all: `Date.parse` coerces first, and
 * `Date.parse(0)` is a real instant in 2000, so a §4.12 row carrying a number there would
 * win the min and be written back into a `string` field. NaN loses both comparisons, so
 * the incoming `at` is taken and the row heals.
 */
function instant(iso: unknown): number {
  return typeof iso === "string" ? Date.parse(iso) : NaN;
}

/**
 * §5.1 types the aggregate as a number. The read path was hardened against the row shapes
 * §4.12's sync delivers (`normalizeVehicle`); this is the same guard on the write path,
 * where `+ 1` on a stored `"3"` would store `"31"` and grow it on every later scan.
 * `structural` is rebuilt and `decode` defaulted on every write for the same reason; a
 * count that is not a whole number of scans is treated as absent rather than repaired,
 * because the §5.2 log is the only thing that could say what it should have been.
 */
function countedScans(existing: VehicleRecord | undefined): number {
  const count = existing?.scanCount;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0;
}

/**
 * §5.2's id is a UUID. `crypto.randomUUID` is `[SecureContext]`, so over plain http it is
 * `undefined` — and that origin is one the app is built for: §6.3 routes an insecure
 * context to `error(insecure_context)`, and the keyboard §6.4 sends the user to writes
 * through here. `getRandomValues` carries no such gate, so the fallback is a v4 built from
 * it rather than a weaker id shape; `Math.random` is the last resort for a runtime with no
 * `crypto` at all. The shape is not cosmetic: §5.2 is append-only and S4 pushes these ids
 * as the primary key that makes a push idempotent (§4.12), so they must not collide.
 */
function newEventId(): string {
  const webCrypto: Crypto | undefined = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // RFC 4122 version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant 10xx
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
      scanCount: countedScans(existing) + 1,
      // How the record first entered this device; a re-scan does not rewrite provenance.
      origin: existing?.origin ?? input.origin,
      metaUpdatedAt: metaChanged ? nowIso() : (existing?.metaUpdatedAt ?? META_NEVER_EDITED),
      // §4.12: any later scan event clears the tombstone.
      deletedAt: null,
    };

    const event: ScanEvent = {
      id: newEventId(),
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
