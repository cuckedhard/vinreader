/**
 * [TA1] §5.5's two missing halves: "Seeded from `wmi-seed.json` on first run; upserted
 * from every successful decode", and §5.1's `manufacturerFromWmi  // from wmi cache/seed`.
 *
 * `wmiCache.test.ts` holds the finding's own repro (the second truck off a WMI a decode
 * already named). This file covers the seam that fix is built on: the seed write, and the
 * read's behaviour on a cache row that is absent, empty or the wrong shape.
 *
 * The committed `wmi-seed.json` is `{}` until `bun run seed:wmi` runs on a host that can
 * reach vPIC (D09), so the populated seed is injected here, exactly as `wmi.test.ts`
 * mocks the artifact for the pure lookup.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./db";
import { seedWmiCache, withCachedManufacturer } from "./wmiCache";
import { upsertVehicle } from "./upsert";
import { buildStructural } from "../vin/structural";
import type { WmiSeedRow } from "../vin/wmi";
import type { WmiRecord } from "../vin/types";

/** §4.5's own candidate list, two of its heavy-truck rows, in the shape the script writes. */
const SEED: readonly WmiSeedRow[] = [
  { wmi: "1FU", manufacturer: "DAIMLER TRUCKS NORTH AMERICA LLC", make: "FREIGHTLINER" },
  { wmi: "4V4", manufacturer: "VOLVO TRUCKS NORTH AMERICA", make: null },
];

const TRUCK = "1FUJGLDR49SAV1234";

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
});

describe("[TA1] seedWmiCache — §5.5 'seeded from wmi-seed.json on first run'", () => {
  it("writes one §5.5 row per seed entry, sourced 'seed'", async () => {
    expect(await seedWmiCache(SEED)).toBe(2);

    expect(await db.wmi.get("1FU")).toMatchObject({
      wmi: "1FU",
      manufacturer: "DAIMLER TRUCKS NORTH AMERICA LLC",
      make: "FREIGHTLINER",
      source: "seed",
    });
    expect((await db.wmi.get("4V4"))?.make).toBeNull();
    expect(typeof (await db.wmi.get("4V4"))?.updatedAt).toBe("string");
  });

  it("is idempotent across runs — a second start writes nothing", async () => {
    await seedWmiCache(SEED);
    expect(await seedWmiCache(SEED)).toBe(0);
    expect(await db.wmi.count()).toBe(2);
  });

  it("never overwrites a vPIC row with the seed (§4.5: vPIC is authoritative)", async () => {
    const fromVpic: WmiRecord = {
      wmi: "1FU",
      manufacturer: "DAIMLER TRUCKS NORTH AMERICA LLC (vPIC)",
      make: "FREIGHTLINER",
      source: "vpic",
      updatedAt: "2026-02-11T09:30:00.000-06:00",
    };
    await db.wmi.put(fromVpic);

    expect(await seedWmiCache(SEED)).toBe(1); // only 4V4
    expect(await db.wmi.get("1FU")).toEqual(fromVpic);
  });

  it("touches nothing when the compiled seed is empty — today's committed artifact", async () => {
    expect(await seedWmiCache([])).toBe(0);
    expect(await seedWmiCache()).toBe(0);
    expect(await db.wmi.count()).toBe(0);
  });

  it("a seeded row reaches the record the next scan writes", async () => {
    await seedWmiCache(SEED);
    const record = await upsertVehicle({
      vin: TRUCK,
      origin: "scan",
      symbology: "code_39",
      raw: TRUCK,
      checkDigitValid: true,
    });
    expect(record.structural.manufacturerFromWmi).toBe("DAIMLER TRUCKS NORTH AMERICA LLC");
    expect((await db.vehicles.get(TRUCK))?.structural.manufacturerFromWmi).toBe(
      "DAIMLER TRUCKS NORTH AMERICA LLC",
    );
  });
});

describe("[TA1] withCachedManufacturer — §5.1 'from wmi cache/seed'", () => {
  const structural = () => buildStructural(TRUCK, 2026);

  it("leaves the compiled-seed answer alone when the cache holds no row", async () => {
    expect(await withCachedManufacturer(structural())).toEqual(structural());
  });

  it("treats a blank stored manufacturer as no answer rather than as an empty name", async () => {
    await db.wmi.put({
      wmi: "1FU",
      manufacturer: "   ",
      make: null,
      source: "vpic",
      updatedAt: "2026-02-11T09:30:00.000-06:00",
    });
    expect((await withCachedManufacturer(structural())).manufacturerFromWmi).toBeNull();
  });

  it("treats a stored value of the wrong type as no answer (a corrupted row)", async () => {
    await db.wmi.put({
      wmi: "1FU",
      manufacturer: 42 as unknown as string,
      make: null,
      source: "vpic",
      updatedAt: "2026-02-11T09:30:00.000-06:00",
    });
    expect((await withCachedManufacturer(structural())).manufacturerFromWmi).toBeNull();
  });

  it("trims the stored name and changes nothing else about the block", async () => {
    await db.wmi.put({
      wmi: "1FU",
      manufacturer: "  DAIMLER TRUCKS NORTH AMERICA LLC  ",
      make: "FREIGHTLINER",
      source: "vpic",
      updatedAt: "2026-02-11T09:30:00.000-06:00",
    });
    expect(await withCachedManufacturer(structural())).toEqual({
      ...structural(),
      manufacturerFromWmi: "DAIMLER TRUCKS NORTH AMERICA LLC",
    });
  });
});
