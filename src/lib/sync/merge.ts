/**
 * §4.12's merge rules, on the client. "Identical on server and client" is the requirement,
 * so every function below is written against the SQL in `supabase/migrations/0001_init.sql`
 * — `better_decode`, `decode_rank`, and the `on conflict do update` body of
 * `upsert_vehicle_meta` — and the comments name the statement each rule mirrors.
 *
 * Pure: no Dexie, no client, no clock. The current year arrives as an argument (§4.4) and
 * so does everything the pull knows about what has not been pushed yet, which makes every
 * rule here testable as a table of inputs.
 *
 * One asymmetry is deliberate and is not a deviation. The server merges *incoming into
 * stored*; the client merges *pulled into local*, so "existing" here means the local row.
 * Ties therefore keep the device's value, which is what "ties keep the existing value"
 * means on this side of the wire.
 */
import { buildStructural } from "../vin/structural";
import type { VehicleDecode, VehicleRecord } from "../vin/types";
import { pendingDecode } from "../storage/upsert";
import type { RemoteVehicle } from "./types";

/**
 * What the outbox still holds for this VIN. §4.12 states one rule of this kind — "a local
 * vehicle that still has an unpushed `vehicle_meta` newer than the server's
 * `meta_updated_at` keeps its local unit/notes until pushed" — and the other two fields
 * carry the same idea to the tombstone, where §4.12's own rule ("any later scan event
 * clears it") can be applied to an event the server has not received yet.
 */
export interface PendingLocal {
  /** Newest `p_meta_updated_at` among unpushed `vehicle_meta` rows, or null. */
  metaUpdatedAt: string | null;
  /** An unpushed `vehicle_delete` — an intent the account has not seen. */
  deleteQueued: boolean;
  /** Newest `at` among unpushed `scan_event` rows, or null. */
  scanAt: string | null;
}

export const NO_PENDING: PendingLocal = { metaUpdatedAt: null, deleteQueued: false, scanAt: null };

/**
 * Offset timestamps do not sort as strings (§5.1), and a stored value that is not a string
 * is not a timestamp at all — `Date.parse(0)` is a real instant in 2000. NaN loses every
 * comparison below, which is the answer we want for a value we cannot read.
 */
function instant(iso: unknown): number {
  return typeof iso === "string" ? Date.parse(iso) : NaN;
}

/** `a` is strictly newer than `b`. A value that does not parse is never newer. */
function newer(a: unknown, b: unknown): boolean {
  const left = instant(a);
  const right = instant(b);
  if (Number.isNaN(left)) return false;
  return Number.isNaN(right) || left > right;
}

/** Mirrors `least(a, b)` — Postgres ignores nulls here rather than propagating them. */
function earliest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return newer(b, a) ? a : b;
}

/** Mirrors `greatest(a, b)`, same null handling. */
function latest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return newer(b, a) ? b : a;
}

/** `public.decode_rank`: ok 3 > partial 2 > unsupported 1 > pending/failed/absent 0. */
export function decodeRank(decode: { status?: unknown } | null | undefined): number {
  switch (decode?.status) {
    case "ok":
      return 3;
    case "partial":
      return 2;
    case "unsupported":
      return 1;
    default:
      return 0;
  }
}

/**
 * `public.better_decode(a, b)`: higher rank wins; equal rank breaks on the newer
 * `fetchedAt`; anything else keeps `a`. `coalesce(..., '-infinity')` in the SQL is the
 * `newer()` guard here — a null or unparseable `fetchedAt` never wins a tie.
 */
export function betterDecode(a: VehicleDecode, b: VehicleDecode | null): VehicleDecode {
  if (b === null) return a;
  const rankA = decodeRank(a);
  const rankB = decodeRank(b);
  if (rankB > rankA) return b;
  if (rankB === rankA && newer(b.fetchedAt, a.fetchedAt)) return b;
  return a;
}

/**
 * §4.12: "a local vehicle that still has an unpushed `vehicle_meta` newer than the server's
 * `meta_updated_at` keeps its local unit/notes until pushed."
 *
 * Under the invariant `upsert.ts` maintains — a record's `metaUpdatedAt` is the newest
 * clock any of its writes carried, so it is never older than a queued row's — this guard
 * can only fire when that invariant is already broken. It is written out anyway because
 * §4.12 states it, and because the invariant is one file's discipline rather than a thing
 * the type system holds: if a future write path queues a row without moving the record's
 * clock, this is the rule that keeps the queued edit from being erased before it is sent.
 */
function remoteMetaWins(
  local: VehicleRecord,
  remote: RemoteVehicle,
  pending: PendingLocal,
): boolean {
  if (!newer(remote.metaUpdatedAt, local.metaUpdatedAt)) return false;
  return !newer(pending.metaUpdatedAt, remote.metaUpdatedAt);
}

/**
 * §4.12's `deleted_at` rules, applied to what this device knows:
 * - a queued `vehicle_delete` is an intent the account has not seen, so the local tombstone
 *   stands until it is pushed — otherwise a pull would resurrect a record the user deleted
 *   seconds ago, and it would stay resurrected until the delete landed and came back;
 * - "any later scan event clears it" — including an event still in the outbox, because that
 *   event will clear the tombstone server-side the moment it is pushed;
 * - otherwise the server's value is the answer, in both directions: it is set when the
 *   account holds a tombstone, and cleared when another device's scan already cleared it.
 */
function mergedDeletedAt(
  local: VehicleRecord | undefined,
  remote: RemoteVehicle,
  pending: PendingLocal,
): string | null {
  if (pending.deleteQueued) return local?.deletedAt ?? remote.deletedAt;
  if (remote.deletedAt !== null && newer(pending.scanAt, remote.deletedAt)) return null;
  return remote.deletedAt;
}

/**
 * §5.1's aggregate is a count of events, and each side counts only the events it holds:
 * the account has not seen what is still in the outbox, and this device has not seen what
 * another device scanned before its own first pull. Neither number is wrong, so the merge
 * takes the larger and never moves an aggregate backwards. §4.12 forbids *pushing* these
 * three fields, not deriving them locally.
 */
function mergedScanCount(local: VehicleRecord | undefined, remote: RemoteVehicle): number {
  const localCount =
    typeof local?.scanCount === "number" &&
    Number.isInteger(local.scanCount) &&
    local.scanCount >= 0
      ? local.scanCount
      : 0;
  const remoteCount =
    Number.isInteger(remote.scanCount) && remote.scanCount >= 0 ? remote.scanCount : 0;
  return Math.max(localCount, remoteCount);
}

/**
 * Merge one pulled `vehicles` row into the local record, or return null when there is
 * nothing to write.
 *
 * Null happens in exactly one case: a tombstone for a VIN this device has never held.
 * §4.12 says pulled rows carrying `deleted_at` are removed locally, and a row that was
 * never here is already removed — writing a tombstone for it would put a record on the
 * phone whose only purpose is to be hidden.
 *
 * For a VIN this device *does* hold, "removed locally" is the same soft delete the Sheet's
 * Delete performs (§5.1 `deletedAt`, `softDeleteVehicle`): the record leaves History and
 * the Sheet, the §5.2 log keeps the scans that produced it, and §4.7's permanent decode
 * cache survives — a hard delete would spend a second vPIC request the next time the VIN
 * is scanned, and §4.7 allows one per VIN ever.
 */
export function mergeVehicle(
  local: VehicleRecord | undefined,
  remote: RemoteVehicle,
  context: { currentYear: number; pending?: PendingLocal },
): VehicleRecord | null {
  const pending = context.pending ?? NO_PENDING;
  const deletedAt = mergedDeletedAt(local, remote, pending);
  if (local === undefined && deletedAt !== null) return null;

  // `structural`: §4.12 keeps the first non-empty block. The local one is never empty —
  // it is a pure function of the 17 characters (§4.1–§4.5), rebuilt on every write and on
  // every read (`normalizeVehicle`) — so "first non-empty" resolves to the local block,
  // and rebuilding it here is that same answer computed rather than copied. A row created
  // from a pulled tombstone-free VIN this device has never seen gets one for the first time.
  const structural = buildStructural(remote.vin, context.currentYear);

  if (local === undefined) {
    return {
      vin: remote.vin,
      structural,
      decode: betterDecode(pendingDecode(), remote.decode),
      unit: remote.unit,
      notes: remote.notes,
      paint: remote.paint,
      // S5 layer 2 (additive to §5.1): a row this device has never seen carries a paint
      // code whose provenance nothing can tell it. `upsert_vehicle_meta` has no parameter
      // for it and §4.12 has no column, so null — "not known" — rather than a guess that
      // would render as a fact (N2).
      paintSource: null,
      paintConfidence: null,
      // The server's aggregates are all this device knows; `apply_scan_event` leaves them
      // null only for a row born of `upsert_vehicle_meta`, whose meta clock is the one
      // timestamp such a row does carry.
      firstScannedAt: remote.firstScannedAt ?? remote.lastScannedAt ?? remote.metaUpdatedAt,
      lastScannedAt: remote.lastScannedAt ?? remote.firstScannedAt ?? remote.metaUpdatedAt,
      scanCount: mergedScanCount(local, remote),
      // D12: `cloud` is written by this path and no other.
      origin: "cloud",
      metaUpdatedAt: remote.metaUpdatedAt,
      deletedAt: null,
    };
  }

  const takeRemoteMeta = remoteMetaWins(local, remote, pending);
  return {
    ...local,
    structural,
    // `decode = public.better_decode(vehicles.decode, excluded.decode)`.
    decode: betterDecode(local.decode, remote.decode),
    // `unit = case when excluded.meta_updated_at > vehicles.meta_updated_at then excluded.unit
    //  else vehicles.unit end`, and the same for `notes`.
    unit: takeRemoteMeta ? remote.unit : local.unit,
    notes: takeRemoteMeta ? remote.notes : local.notes,
    // `paint = case when excluded.meta_updated_at > vehicles.meta_updated_at then
    //  excluded.paint else vehicles.paint end` (migration 0002) — the same clock and the
    //  same comparison, so a clear propagates and a tie keeps this device's value.
    paint: takeRemoteMeta ? remote.paint : local.paint,
    // Provenance travels with the value: this device's own knowledge of how a code was
    // captured survives exactly as long as the code it was about. A remote value winning
    // the clock replaces the string, and nothing came with it to say where it came from.
    paintSource: takeRemoteMeta && remote.paint !== local.paint ? null : local.paintSource,
    paintConfidence:
      takeRemoteMeta && remote.paint !== local.paint ? null : local.paintConfidence,
    // `meta_updated_at = greatest(vehicles.meta_updated_at, excluded.meta_updated_at)`.
    metaUpdatedAt: latest(local.metaUpdatedAt, remote.metaUpdatedAt) ?? local.metaUpdatedAt,
    // §4.12: first = min, last = max.
    firstScannedAt: earliest(local.firstScannedAt, remote.firstScannedAt) ?? local.firstScannedAt,
    lastScannedAt: latest(local.lastScannedAt, remote.lastScannedAt) ?? local.lastScannedAt,
    scanCount: mergedScanCount(local, remote),
    deletedAt,
  };
}
