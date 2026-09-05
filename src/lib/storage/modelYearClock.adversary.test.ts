/**
 * §13.2 adversary — a system clock that moved backwards, against §4.4's cap.
 *
 * [G4] `modelYearFromVin` is pure and takes the current year as an argument, exactly as
 * §4.4 requires — but every caller in the app supplies `new Date().getFullYear()` with no
 * floor under it (`upsert.ts:81`, `normalize.ts` via `SheetScreen`/`HistoryScreen`). §4.4
 * step 0 then drops "any candidate greater than the current year + 1", so a clock reading
 * earlier than the truck is younger than the truck, and the rule written to refuse a
 * *future* year refuses the real one instead.
 *
 * `1FUJGLDR0PLBT1234` is a heavy truck: position 10 is `P` (1993 / 2023) and position 7 is
 * a letter, so §4.4 step 1 resolves it to **2023** on any correct clock. On a phone whose
 * clock has fallen back to 2016 — an Android that lost its RTC, a device left flat in the
 * cold overnight, a factory-reset handset with no signal to fetch time from — the cap
 * drops 2023 and the app resolves it to **1993** and shows that as a fact: one year, no
 * "1993 or 2023", no ambiguity note, and it is what gets written to the §5.1 record and
 * queued in §5.7's `vehicle_meta`. N2 exists to stop precisely this — the user is standing
 * next to the truck and the number on the screen is wrong by thirty years, with nothing on
 * screen saying the app is unsure.
 *
 * The §4.4 constant is not in question and nothing here proposes changing it. What is
 * missing is a floor on the argument the callers pass: a clock that reads earlier than the
 * build cannot be trusted to cap anything, and §4.4 already tolerates that case — with no
 * survivors it returns `{ candidates: [], resolved: null }` and the row is simply omitted.
 *
 * Deterministic: `vi.useFakeTimers({ toFake: ["Date"] })` so only the clock is faked and
 * Dexie's own timers keep running. Fixed VIN, fixed `at`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db";
import { upsertVehicle } from "./upsert";
import { modelYearFromVin } from "../vin/modelYear";

/** Check-digit valid; position 7 `D` (a letter), position 10 `P` → 1993 / 2023. */
const VIN = "1FUJGLDR0PLBT1234";

/** A phone whose clock fell back to its build year. */
const SKEWED = new Date("2016-05-01T09:00:00.000Z");

async function scan(): Promise<void> {
  await upsertVehicle({
    vin: VIN,
    origin: "scan",
    symbology: "code_39",
    raw: `I${VIN}`,
    checkDigitValid: true,
  });
}

describe("[G4] a device clock that lost years turns §4.4's cap into a wrong year", () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.delete();
  });

  it("resolves a 2023 truck to 1993 on a phone whose clock reads 2016", async () => {
    // The reference: on a correct clock this is a 2023 truck, resolved and certain.
    expect(modelYearFromVin(VIN, 2026)).toEqual({ candidates: [1993, 2023], resolved: 2023 });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SKEWED);
    await scan();

    const stored = await db.vehicles.get(VIN);
    // TODAY: { candidates: [1993], resolved: 1993 } — one year, stated as a fact, and it
    // is the wrong one. N2 allows two candidates or none; it does not allow this.
    expect(stored?.structural.modelYear.resolved).not.toBe(1993);
  });

  it("queues the wrong year to the account as well, in §5.7's vehicle_meta payload", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SKEWED);
    await scan();

    const meta = (await db.outbox.toArray()).find((row) => row.kind === "vehicle_meta");
    expect(meta).toBeDefined();
    const payload = meta?.payload as { p_structural: { modelYear: { resolved: number | null } } };
    expect(payload.p_structural.modelYear.resolved).not.toBe(1993);
  });
});
