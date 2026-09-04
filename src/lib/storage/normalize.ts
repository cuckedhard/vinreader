import { buildStructural } from "../vin/structural";
import type { VehicleDecode, VehicleRecord, VinStructural } from "../vin/types";

/**
 * Fill a stored row out to a whole `VehicleRecord`.
 *
 * §4.12 defaults `structural` and `decode` to `'{}'::jsonb`, so a row created server-side
 * by `apply_scan_event` — or pulled before its owner's `upsert_vehicle_meta` lands —
 * arrives with both blocks empty. That shape is not corruption, it is the sync protocol,
 * and every screen has to survive it: one unreadable row must cost that row, never the
 * whole route (P7).
 *
 * `structural` is not defended against but REBUILT. It is a pure function of the 17
 * characters (§4.1–§4.5) and the VIN is the primary key, so it is always recoverable and
 * there is always something honest to render.
 */
export function normalizeVehicle(row: VehicleRecord, currentYear: number): VehicleRecord {
  const structural: VinStructural =
    row.structural && typeof row.structural.wmi === "string"
      ? row.structural
      : buildStructural(row.vin, currentYear);

  const stored = row.decode as Partial<VehicleDecode> | undefined;
  const decode: VehicleDecode = {
    status: stored?.status ?? "pending",
    source: "nhtsa_vpic",
    fetchedAt: stored?.fetchedAt ?? null,
    attempts: stored?.attempts ?? 0,
    lastError: stored?.lastError ?? null,
    fields: stored?.fields ?? {},
  };

  return { ...row, structural, decode };
}
