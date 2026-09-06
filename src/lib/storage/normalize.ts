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

  // §5.1 `paint` (S5): absent on every row written before it existed, and on a §4.12 row
  // whose account has no `paint` column yet. Both mean "nobody has typed one" — null, the
  // value a fresh record carries. Anything that is not a string is not a paint code
  // either, and it is read as absent rather than rendered as one (N2).
  const paint = typeof row.paint === "string" ? row.paint : null;

  /**
   * S5 layer 2's provenance, additive to §5.1 and read with the same suspicion as `paint`
   * itself. Absent on every row written before layer 2 and on every row §4.12 delivers,
   * because the RPC has no parameter for it — both mean "this device does not know", which
   * is null and is not "typed".
   *
   * Tied to the value it describes: a row with no paint code has no provenance to carry,
   * and a confidence without an `ocr` source is a number describing nothing. Both are
   * dropped rather than rendered, because a stored figure nothing can calibrate (§13.7 —
   * there is no corpus of real stickers) is exactly the guess project rule 6 forbids
   * showing as a fact.
   */
  const paintSource =
    paint !== null && (row.paintSource === "ocr" || row.paintSource === "typed")
      ? row.paintSource
      : null;
  const paintConfidence =
    paintSource === "ocr" && typeof row.paintConfidence === "number"
      ? row.paintConfidence
      : null;

  return {
    ...row,
    structural: buildStructural(row.vin, currentYear),
    decode,
    paint,
    paintSource,
    paintConfidence,
  };
}
