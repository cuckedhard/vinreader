import { isVinGrammarValid } from "../vin/grammar";
import { buildStructural } from "../vin/structural";
import { pendingDecode } from "./upsert";
import type { VehicleDecode, VehicleRecord } from "../vin/types";

/**
 * Fill a stored row out to a whole `VehicleRecord`, or return null when it cannot be one.
 *
 * §4.12 defaults `structural` and `decode` to `'{}'::jsonb`, and its own schema comment
 * types `decode` as a partial `{ status, source, fetchedAt, fields }`, so a row created by
 * `apply_scan_event` — or pulled before its owner's `upsert_vehicle_meta` lands — arrives
 * with blocks that are empty or half-populated. That is the sync protocol, not corruption.
 *
 * `structural` is rebuilt unconditionally rather than inspected. It is a pure function of
 * the 17 characters (§4.1–§4.5) and the VIN is the primary key, so rebuilding always
 * agrees with a stored block and needs no guess about whether a partial one is usable —
 * a guard that checked one field of eleven let a half-populated block through and still
 * crashed the route.
 *
 * Returns null when the row has no grammar-valid VIN to rebuild from. P7: one unreadable
 * row costs that row, never every other record on the phone, so callers drop it.
 */
export function normalizeVehicle(row: VehicleRecord, currentYear: number): VehicleRecord | null {
  if (typeof row.vin !== "string" || !isVinGrammarValid(row.vin)) return null;

  const stored = row.decode as Partial<VehicleDecode> | undefined;
  const decode: VehicleDecode = { ...pendingDecode(), ...stored, fields: stored?.fields ?? {} };

  return { ...row, structural: buildStructural(row.vin, currentYear), decode };
}
