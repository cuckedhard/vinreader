/**
 * §5.5 `wmi` cache — the two halves that were missing: the first-run seed, and the read.
 *
 * §5.1 types `manufacturerFromWmi` as coming "from wmi cache/seed", and §4.5 ends with
 * "every successful vPIC decode also upserts its WMI into a local `wmi` cache table (§5),
 * **so the seed grows with use**". `decodeQueue.applyDecodeResult` does the upsert; this
 * is what makes the growth mean anything — the next truck off a WMI a decode already
 * named is stored with that manufacturer even with the radio dead (N1: the structural
 * record is what the yard sees, and it is written offline).
 *
 * vPIC stays authoritative where it answered (§4.5, §4.7): the cache only fills a field
 * the compiled seed left null, and `decode.fields.Manufacturer` is rendered from the
 * decode block regardless.
 *
 * Not pure, and it lives here for that reason: `src/lib/vin/` may not read IndexedDB (P3).
 */
import type { VinStructural, WmiRecord } from "../vin/types";
import { type WmiSeedRow, wmiSeedRows } from "../vin/wmi";
import { db, nowIso } from "./db";

/**
 * §5.1's `manufacturerFromWmi`, resolved against the §5.5 table with the compiled seed
 * (already in `structural`) as the fallback. A row whose `manufacturer` is not a
 * non-empty string is treated as absent rather than written into a `string | null` field
 * — the same posture `normalizeVehicle` takes to a stored value of the wrong shape.
 */
export async function withCachedManufacturer(structural: VinStructural): Promise<VinStructural> {
  const cached = await db.wmi.get(structural.wmi);
  const manufacturer = typeof cached?.manufacturer === "string" ? cached.manufacturer.trim() : "";
  return manufacturer ? { ...structural, manufacturerFromWmi: manufacturer } : structural;
}

/**
 * §5.5: "Seeded from `wmi-seed.json` on first run." Adds only the WMIs the table does not
 * already hold, so a `source: "vpic"` row — vPIC's own answer, authoritative over the
 * seed — is never overwritten by a later run, and re-running costs one key scan.
 *
 * Returns the number of rows written, which is what the callers' tests assert on. The
 * seed argument is the test seam: the committed artifact is `{}` until `bun run seed:wmi`
 * runs on a host that can reach vPIC (D09), so the populated path is only reachable with
 * a stand-in.
 */
export async function seedWmiCache(seed: readonly WmiSeedRow[] = wmiSeedRows()): Promise<number> {
  if (seed.length === 0) return 0;
  return db.transaction("rw", db.wmi, async () => {
    const present = new Set(await db.wmi.toCollection().primaryKeys());
    const missing = seed.filter((entry) => !present.has(entry.wmi));
    if (missing.length === 0) return 0;
    const updatedAt = nowIso();
    const rows: WmiRecord[] = missing.map((entry) => ({ ...entry, source: "seed", updatedAt }));
    await db.wmi.bulkPut(rows);
    return rows.length;
  });
}
