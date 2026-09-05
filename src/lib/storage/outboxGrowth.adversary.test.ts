/**
 * §13.2 adversary — storage exhaustion, reached from the one action the app exists for.
 *
 * [G3] Every `upsertVehicle` appends two §5.7 rows: a `scan_event` (keyed by the event id,
 * so it is idempotent) and a `vehicle_meta` (keyed by a fresh `newId()`, so it is not).
 * `vehicle_meta` carries the whole record — `p_structural` **and `p_decode`, every vPIC
 * field** — and §4.12 resolves it last-writer-wins by `p_meta_updated_at`, so for one VIN
 * only the newest row can ever change anything on the server.
 *
 * Nothing drains the outbox while signed out: `push.ts` runs only from the sync engine,
 * and §9-S4's sign-out is the only other thing that calls `clearOutbox`. So on a phone
 * that is never signed in — the configuration §1.2/N7 says must work exactly as well as
 * any other — the outbox is a write-only store fed by every scan and pruned by nothing.
 *
 * Measured here: 51 scans of ONE VIN whose decode has landed leave **102 outbox rows and
 * ~305 KB**, ~6 KB per scan, and among the 51 `vehicle_meta` rows there are **2 distinct
 * payloads**. 49 rows are byte-identical duplicates of a row the server would apply to the
 * same effect. A two-crew yard rescanning 200 already-decoded trucks a day queues about
 * 1.2 MB a day it will never read, until a `QuotaExceededError` lands on the scan path and
 * §6.4's *"Couldn't save this VIN"* is the first the user hears of it.
 *
 * The second-order cost, when the user does sign in: `dueRows()` reads the **whole** table
 * into a JS array before filtering and slicing to 50 (`outbox.ts:150-160`), and a push
 * cycle does that up to `PUSH_MAX_DRAINS` = 10 times.
 *
 * Deterministic: fixed VIN, fixed `at` stamps, no timers, no RNG. `newId()` is the only
 * non-determinism and nothing here asserts on an id.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db";
import { applyDecodeResult } from "./decodeQueue";
import { upsertVehicle } from "./upsert";
import type { VpicResult } from "../vpic/types";

/** §4.11 fixture, check-digit valid. */
const VIN = "1HGCM82633A004352";

/** A landed §4.7 decode, the size a real `DecodeVinValues` answer actually is. */
function decodedFields(): Record<string, string> {
  const fields: Record<string, string> = { Make: "HONDA", Model: "Accord", ModelYear: "2003" };
  for (let i = 0; i < 130; i += 1) fields[`Element${i}`] = "a plausible vPIC value";
  return fields;
}

const DECODE: VpicResult = {
  status: "ok",
  fields: decodedFields(),
  errorText: null,
  lastError: null,
};

async function scan(at: string): Promise<void> {
  await upsertVehicle({
    vin: VIN,
    origin: "scan",
    symbology: "code_39",
    raw: `I${VIN}`,
    checkDigitValid: true,
    at,
  });
}

describe("[G3] the outbox grows without bound from the scan path, signed out", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  afterEach(async () => {
    await db.delete();
  });

  it("queues one redundant vehicle_meta row, decode block and all, for every re-scan", async () => {
    await scan("2026-09-01T08:00:00.000-08:00");
    await applyDecodeResult(VIN, DECODE);

    for (let i = 0; i < 50; i += 1) {
      await scan(`2026-09-02T08:${String(i).padStart(2, "0")}:00.000-08:00`);
    }

    const rows = await db.outbox.toArray();
    const meta = rows.filter((row) => row.kind === "vehicle_meta");
    const distinct = new Set(meta.map((row) => JSON.stringify(row.payload)));

    // P4 holds where it is stated: one vehicle row, however many scans.
    expect(await db.vehicles.count()).toBe(1);
    // And the §5.2 log is append-only by design, so 51 events is correct.
    expect(await db.scanEvents.count()).toBe(51);

    // The finding. §4.12 makes `vehicle_meta` last-writer-wins per VIN, so every row but
    // the newest is storage spent on a fact the account already has. Two payloads exist
    // here — before the decode landed and after — so at most two rows can matter.
    expect({ metaRows: meta.length, distinctPayloads: distinct.size }).toEqual({
      metaRows: distinct.size,
      distinctPayloads: distinct.size,
    });
  });

  it("costs about 6 KB of permanent local storage per re-scan of a decoded VIN", async () => {
    await scan("2026-09-01T08:00:00.000-08:00");
    await applyDecodeResult(VIN, DECODE);

    const record = await db.vehicles.get(VIN);
    const decodeBytes = JSON.stringify(record?.decode).length;

    const before = JSON.stringify(await db.outbox.toArray()).length;
    for (let i = 0; i < 20; i += 1) {
      await scan(`2026-09-02T08:${String(i).padStart(2, "0")}:00.000-08:00`);
    }
    const after = JSON.stringify(await db.outbox.toArray()).length;
    const perScan = Math.round((after - before) / 20);

    // Measured: 5,969 bytes per re-scan against a 5,003-byte decode block and a 388-byte
    // `scan_event` row — so every re-scan queues a fresh copy of the whole §4.7 answer.
    // The §5.2 event is the row a re-scan genuinely adds; a second copy of a decode the
    // account already has is not. A signed-out phone has no sync chip either (§6.4), so
    // the growth is invisible as well as unbounded.
    expect(decodeBytes).toBeGreaterThan(4000);
    expect(perScan).toBeLessThan(decodeBytes);
  });
});
