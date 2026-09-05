/**
 * [T-WMI] §5.5's `wmi` cache is write-only, and §4.5's seed is empty, so the manufacturer
 * a record carries offline is `null` for every VIN ever scanned.
 *
 * THESE TWO TESTS FAIL ON PURPOSE. They are the repro for the finding, not a regression.
 *
 * What the spec says:
 *  - §5.1: `manufacturerFromWmi: string | null;  // from wmi cache/seed`
 *  - §5.5: "`wmi` cache — keyed by `wmi`. Seeded from `wmi-seed.json` on first run;
 *    upserted from every successful decode."
 *  - §4.5: "At runtime, every successful vPIC decode also upserts its WMI into a local
 *    `wmi` cache table (§5), **so the seed grows with use**."
 *
 * What the code does: `decodeQueue.applyDecodeResult` writes `db.wmi` (that half works,
 * and is asserted below so this file cannot be read as "the cache is broken"), and nothing
 * anywhere reads it — `grep -rn 'db\.wmi' src/` returns one write and no read.
 * `buildStructural` resolves the manufacturer from the compiled-in `wmi-seed.json` only,
 * and that file holds **0 entries**, so `manufacturerFromWmi` returns `null` for every WMI
 * in existence. The table is never seeded from it either.
 *
 * The cost is exactly the case this app is for: a truck scanned in a yard with no signal
 * shows no manufacturer, including a truck whose fleet-mate was decoded on the same phone
 * an hour earlier. §6.2 drops an empty row, so it reads as "this vehicle has no
 * manufacturer" rather than as anything being wrong — the same shape as the `CabType` key
 * that rendered nothing for every vehicle for four rounds.
 *
 * The assertion is on the stored record because §5.1 is where the spec puts the field, and
 * `StructuralBlock.tsx:131` renders that field.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./db";
import { applyDecodeResult } from "./decodeQueue";
import { upsertVehicle } from "./upsert";
import type { VpicResult } from "../vpic/types";
import { manufacturerFromWmi } from "../vin/wmi";

/** §4.11 heavy trucks. Same WMI `1FU`, different vehicles. */
const TRUCK_DECODED = "1FUJGLDR49SAV1234";
const TRUCK_LATER = "1FUJA6CK14LM12345";

/** Synthetic, in §4.7's documented shape: a decode that names the manufacturer. */
const DECODED: VpicResult = {
  status: "ok",
  fields: {
    ErrorCode: "0",
    Make: "FREIGHTLINER",
    Model: "Cascadia",
    Manufacturer: "DAIMLER TRUCKS NORTH AMERICA LLC",
  },
  errorText: null,
  lastError: null,
};

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
});

describe("[T-WMI] §5.5 the WMI cache, and §4.5's 'the seed grows with use'", () => {
  it("writes the cache row on a successful decode", async () => {
    // The half that works. Kept so the failing case below cannot be misread as this one.
    await upsertVehicle({
      vin: TRUCK_DECODED,
      origin: "scan",
      symbology: "code_39",
      raw: TRUCK_DECODED,
      checkDigitValid: true,
    });
    await applyDecodeResult(TRUCK_DECODED, DECODED);

    expect(await db.wmi.get("1FU")).toMatchObject({
      wmi: "1FU",
      manufacturer: "DAIMLER TRUCKS NORTH AMERICA LLC",
      make: "FREIGHTLINER",
      source: "vpic",
    });
  });

  it("FAILS: the next truck off the same WMI is stored with no manufacturer at all", async () => {
    await upsertVehicle({
      vin: TRUCK_DECODED,
      origin: "scan",
      symbology: "code_39",
      raw: TRUCK_DECODED,
      checkDigitValid: true,
    });
    await applyDecodeResult(TRUCK_DECODED, DECODED);
    expect((await db.wmi.get("1FU"))?.manufacturer).toBe("DAIMLER TRUCKS NORTH AMERICA LLC");

    // A second truck out of the same fleet, scanned with the radio dead — §4.7 will not
    // answer, and §4.5 says the cache is what covers exactly this.
    const later = await upsertVehicle({
      vin: TRUCK_LATER,
      origin: "scan",
      symbology: "code_39",
      raw: TRUCK_LATER,
      checkDigitValid: true,
    });

    expect(later.structural.wmi).toBe("1FU");
    // Today: null. `buildStructural` reads only the compiled seed, which is empty, and
    // nothing in `src/` reads `db.wmi`.
    expect(later.structural.manufacturerFromWmi).toBe("DAIMLER TRUCKS NORTH AMERICA LLC");
  });

  it("FAILS: the compiled §4.5 seed names not one of the WMIs §4.5 lists", () => {
    // §4.5's "Heavy truck and chassis" candidate row, verbatim — this fleet's own WMIs.
    // §4.5 allows candidates to be dropped when vPIC does not resolve them ("Unresolved
    // candidates are dropped"), but `wmi-seed.json` holds **0 entries in total**, across
    // every class in that section, so `bun run seed:wmi` has never produced an artifact.
    // Until it does, `manufacturerFromWmi` is a function that returns null.
    const candidates = [
      "1FU",
      "1FV",
      "1XK",
      "1XP",
      "1M1",
      "1HT",
      "4V4",
      "1NK",
      "2NK",
      "3AK",
      "5KJ",
    ];
    const resolved = candidates.filter((wmi) => manufacturerFromWmi(wmi) !== null);

    expect(resolved.length).toBeGreaterThan(0);
  });
});
