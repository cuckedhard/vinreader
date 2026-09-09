/**
 * §5.3 upsert — keyed by VIN, idempotent, never duplicates (P4).
 *
 * Local writes only. `origin: "cloud"` is deliberately not accepted (D12): the S4 pull
 * path applies server rows through its own apply path, because routing them here would
 * inflate `scanCount` on every pull and fabricate scan events.
 *
 * S4: this is also where §4.12's "every local write also appends an outbox row" is kept.
 * All five paths it names — scan, manual, import, unit/notes edit, delete — reach storage
 * through the functions below, so the feed is one seam rather than a rule every screen has
 * to remember; the append shares each write's transaction, and no screen changed to gain
 * it. The one local write to a `vehicles` row that does not pass through here is §5.4's
 * decode queue, which fills `decode` after the fact.
 */
import { buildStructural } from "../vin/structural";
import type {
  PaintSource,
  ScanEvent,
  Symbology,
  VehicleDecode,
  VehicleRecord,
} from "../vin/types";
import { META_NEVER_EDITED } from "../vin/types";
import { currentYear, db, newId, nowIso } from "./db";
import { appendOutbox, scanEventRow, vehicleDeleteRow, vehicleMetaRow } from "./outbox";
import { withCachedManufacturer } from "./wmiCache";

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
  /**
   * §4.9 `pc`. Carried by an import — the only write that has one to offer in S5 layer 1,
   * since no scan reads a paint code off a label. It fills an empty field and never
   * replaces a stored one; see the rule below.
   */
  paint?: string | null;
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
 * §5.3 for `unit` and `notes` (R3-C): "keep existing … unless the incoming payload has
 * non-empty values **and the user confirms overwrite**". No write that reaches this
 * function carries that confirmation — a payload arrived, or a label was scanned — so a
 * stored value with text in it stays, and an incoming one fills an empty field. The
 * confirmed overwrite is `setVehicleMeta`, offered on the Import preview beside the value
 * it would replace, exactly as it already is for the paint code below.
 *
 * `notes` is free text a person typed beside a truck and nothing downstream can
 * reconstruct it, so this is the same reasoning the paint code gets and not a weaker one.
 * The one difference is that an empty field is still filled, because §4.9's payload is how
 * a unit reaches a phone that has never had one.
 *
 * The stored value is handed back **as it stands** rather than trimmed: §4.12 delivers what
 * another device wrote, the server trims nothing, and a trimmed copy reads as a changed
 * field to `metaChanged` below — which would move the LWW clock on a plain re-scan and let
 * a scan outrank a real edit (D11).
 */
function keptOverIncoming(
  stored: string | null | undefined,
  incoming: string | null,
): string | null {
  return meaningful(stored) === null ? incoming : (stored ?? null);
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

export async function upsertVehicle(input: UpsertInput): Promise<VehicleRecord> {
  const at = input.at ?? nowIso();
  const incomingUnit = meaningful(input.unit);
  const incomingNotes = meaningful(input.notes);
  // [G4] §4.4 step 0 caps against this, so it is the floored year and not the raw clock.
  const year = currentYear();

  // §4.12: the outbox is in scope because the rows it takes are part of this write, not a
  // follow-up to it. A scan that commits without its outbox rows is a scan that never
  // syncs, with nothing left to notice the gap.
  return db.transaction("rw", db.vehicles, db.scanEvents, db.outbox, db.wmi, async () => {
    const existing = await db.vehicles.get(input.vin);
    // §5.1: `manufacturerFromWmi` comes from the cache *or* the seed. The read is here
    // rather than in `buildStructural` because P3 keeps `src/lib/vin/` free of I/O, and
    // it is inside the transaction so the row a scan is written with is the row the
    // cache held when it was written.
    const structural = await withCachedManufacturer(buildStructural(input.vin, year));
    const unit = keptOverIncoming(existing?.unit, incomingUnit);
    const notes = keptOverIncoming(existing?.notes, incomingNotes);
    /**
     * §5.3 for the paint code, and the one place it differs from unit and notes: the
     * stored value wins, always. A paint code has no check digit and no grammar (§4.9,
     * ruled 2026-09-06), so nothing downstream can ever contradict a wrong one — it
     * renders, syncs, exports and is read aloud at a paint counter exactly as
     * confidently as a right one. §5.3's "unless … the user confirms overwrite" is
     * therefore the whole rule here rather than half of it, and the confirmed overwrite
     * is `setVehicleMeta` below: an edit a human made on screen, never a write that
     * arrived. Nothing about that question sits in front of this write — the record
     * saves offline, in one transaction, and the incoming value is offered afterwards
     * or not at all (N1, P1).
     */
    const storedPaint = meaningful(existing?.paint);
    const paint = storedPaint ?? meaningful(input.paint);
    /**
     * S5 layer 2, additive to §5.1: provenance travels with the value it describes.
     *
     * The stored code keeps its own — this write did not touch it. A code that arrives
     * here fills an empty field and lands with **null**, because no write that reaches
     * this function can say how it was captured: §4.9's payload has no slot for it and
     * neither has §4.12's `upsert_vehicle_meta`, so "another device had this string" is
     * the whole of what this device knows. Null is that, and it is not "typed" (N2).
     */
    const paintSource = storedPaint === null ? null : (existing?.paintSource ?? null);
    const paintConfidence = storedPaint === null ? null : (existing?.paintConfidence ?? null);
    // D11: the LWW clock moves only when this write actually lands unit, notes or the
    // paint code — a user edit, or an import carrying them. A plain re-scan must leave it
    // alone, or a scan on one device silently wipes an earlier real edit made on another
    // (§4.12).
    const metaChanged =
      unit !== (existing?.unit ?? null) ||
      notes !== (existing?.notes ?? null) ||
      paint !== (existing?.paint ?? null);

    const record: VehicleRecord = {
      vin: input.vin,
      // Derived from the 17 characters alone — plus §5.5's cache for the one field §5.1
      // sources there — so it is recomputed on every write and a record stored before a
      // constants fix, or before its WMI was known, heals itself.
      structural,
      // §5.3 keeps an existing decode of ok / partial / unsupported and otherwise takes
      // the incoming one if better. Nothing here ever carries a decode — every write
      // starts pending, the lowest rank (§4.12) — so keeping the existing block is that
      // rule in full. The rank merge lands in S2, where real decodes arrive.
      decode: existing?.decode ?? pendingDecode(),
      unit,
      notes,
      paint,
      paintSource,
      paintConfidence,
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
      id: newId(),
      vin: input.vin,
      at,
      symbology: input.symbology,
      raw: input.raw,
      checkDigitValid: input.checkDigitValid,
      deviceLabel: input.deviceLabel ?? null,
    };

    await db.vehicles.put(record);
    await db.scanEvents.add(event);
    // §4.12's two halves of one scan: the event, which the server's trigger turns into the
    // aggregates a client never pushes, and the meta row, which carries the structural
    // decode, unit and notes no event has room for. Either order converges — the trigger
    // and the RPC both create the row on conflict — so nothing depends on which lands
    // first. D03 needs no check here: on a check-digit mismatch nothing calls this at all.
    await appendOutbox([scanEventRow(event, input.origin), vehicleMetaRow(record)]);
    return record;
  });
}

/**
 * The only path that moves `metaUpdatedAt` off the epoch by hand: a user edit to unit,
 * notes or the paint code, stamped with the device clock (D11, §4.12). An explicit `null`
 * or empty string clears the field; `undefined` leaves it as it was.
 *
 * It is also the only path that may *replace* a paint code (§5.3): every value here came
 * from a person acting on this screen — typing it, or confirming a replacement offered to
 * them — which is the confirmation §5.3 asks for and the only check a paint code has
 * (§4.9, N2). A later OCR proposal ends the same way: a human confirms, and the confirmed
 * string is saved through here.
 */
export async function setVehicleMeta(
  vin: string,
  patch: {
    unit?: string | null;
    notes?: string | null;
    paint?: string | null;
    /**
     * S5 layer 2, and three distinct values rather than two.
     *
     * `"ocr"` is the capture screen's alone, and only for a string the engine returned and
     * a person then tapped with the characters inside the control. **Absent** means a
     * person put these characters here — the Sheet's field, a per-character correction, a
     * lookalike picked off `confusion.ts`'s table, or the incoming value on the import
     * screen's conflict prompt. An explicit **`null`** is a caller saying *this device does
     * not know*, which is what `upsertVehicle` writes for a code that arrived from
     * somewhere else, and it is not the same statement as "typed": "typed" says a person
     * on this phone read the glyphs off the sticker, and a caller that cannot say that must
     * be able to say nothing instead (N2 — nothing downstream can contradict either).
     */
    paintSource?: PaintSource;
    paintConfidence?: number | null;
  },
): Promise<VehicleRecord> {
  return db.transaction("rw", db.vehicles, db.outbox, async () => {
    const existing = await db.vehicles.get(vin);
    if (!existing) throw new Error(`setVehicleMeta: no record for VIN ${vin}`);
    const paint = patch.paint === undefined ? (existing.paint ?? null) : meaningful(patch.paint);
    /**
     * Provenance changes only when the value it describes changes.
     *
     * The Sheet saves unit, notes and paint together on every tap of one button, so a
     * user editing only the unit hands this function the paint code that is already
     * stored. Deriving the provenance from "this patch carried a paint" would relabel a
     * camera read as typed on an edit that never touched it — a lie about the one field
     * nothing downstream can check (N2). It is derived from the value moving instead.
     *
     * A cleared code keeps no provenance, and nothing but an `ocr` source may carry a
     * confidence: a number attached to characters a person typed describes nothing.
     *
     * The default is applied to an **absent key only**. `??` cannot tell "the caller said
     * nothing" from "the caller said it does not know", and collapsing the second into
     * `"typed"` writes a sentence onto the record that is not true — the sheet reads this
     * field to say how the characters got there, and nothing downstream can contradict it
     * (N2). `undefined` is the Sheet and the capture screen, where a person did type or
     * confirm; `null` is a caller that cannot say that.
     */
    const paintChanged = paint !== (existing.paint ?? null);
    const paintSource: PaintSource = !paintChanged
      ? (existing.paintSource ?? null)
      : paint === null
        ? null
        : patch.paintSource === undefined
          ? "typed"
          : patch.paintSource;
    const paintConfidence = !paintChanged
      ? (existing.paintConfidence ?? null)
      : paintSource === "ocr"
        ? (patch.paintConfidence ?? null)
        : null;
    const next: VehicleRecord = {
      ...existing,
      unit: patch.unit === undefined ? existing.unit : meaningful(patch.unit),
      notes: patch.notes === undefined ? existing.notes : meaningful(patch.notes),
      paint,
      paintSource,
      paintConfidence,
      metaUpdatedAt: nowIso(),
    };
    await db.vehicles.put(next);
    // The clock this row carries is the one §4.12 resolves the edit by, so the queued row
    // must be the record as saved — not the patch, which says nothing about the field the
    // user left alone.
    await appendOutbox([vehicleMetaRow(next)]);
    return next;
  });
}

/**
 * §4.12's delete: a tombstone, not a removal. The local row stays so History and the Sheet
 * can hide it while the §5.2 log — append-only — keeps the scans that produced it, and the
 * queued `vehicle_delete` carries the intent to the account. A later scan of the same VIN
 * clears `deletedAt` on both sides.
 *
 * A VIN this device does not hold is not an error and not a queued delete: there is
 * nothing to hide locally, and pushing a delete for a row this device never saw could only
 * act on another device's record.
 */
export async function softDeleteVehicle(vin: string): Promise<VehicleRecord | null> {
  return db.transaction("rw", db.vehicles, db.outbox, async () => {
    const existing = await db.vehicles.get(vin);
    if (!existing) return null;
    // Already a tombstone: re-queueing would push the same intent twice for no new fact.
    if (existing.deletedAt !== null) return existing;
    const next: VehicleRecord = { ...existing, deletedAt: nowIso() };
    await db.vehicles.put(next);
    await appendOutbox([vehicleDeleteRow(vin)]);
    return next;
  });
}
