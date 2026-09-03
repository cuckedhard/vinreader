import { beforeEach, describe, expect, it } from "vitest";
import { META_NEVER_EDITED } from "../vin/types";
import { db } from "./db";
import { setVehicleMeta, upsertVehicle, type UpsertInput } from "./upsert";

const VIN = "1HGCM82633A004352"; // §4.11 fixture: grammar ok, check digit valid.
const T1 = "2026-01-05T08:15:00.000-06:00";
const T2 = "2026-02-11T09:30:00.000-06:00";
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

function scan(overrides: Partial<UpsertInput> = {}): UpsertInput {
  return {
    vin: VIN,
    origin: "scan",
    symbology: "code_39",
    raw: VIN,
    checkDigitValid: true,
    ...overrides,
  };
}

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
});

describe("upsertVehicle", () => {
  it("creates the record on a first scan", async () => {
    const record = await upsertVehicle(scan({ at: T1 }));

    expect(record.vin).toBe(VIN);
    expect(record.scanCount).toBe(1);
    expect(record.firstScannedAt).toBe(T1);
    expect(record.lastScannedAt).toBe(T1);
    expect(record.origin).toBe("scan");
    expect(record.deletedAt).toBeNull();
    expect(record.structural.wmi).toBe("1HG");
    expect(record.structural.checkDigitValid).toBe(true);
    expect(record.decode).toEqual({
      status: "pending",
      source: "nhtsa_vpic",
      fetchedAt: null,
      attempts: 0,
      lastError: null,
      fields: {},
    });
    // D11: never the scan time, or a later scan outranks a real edit under §4.12 LWW.
    expect(record.metaUpdatedAt).toBe(META_NEVER_EDITED);

    expect(await db.vehicles.count()).toBe(1);
    expect(await db.scanEvents.count()).toBe(1);
  });

  it("defaults both timestamps to ISO 8601 with offset", async () => {
    const record = await upsertVehicle(scan());

    expect(record.firstScannedAt).toMatch(ISO_WITH_OFFSET);
    expect(record.lastScannedAt).toBe(record.firstScannedAt);
  });

  it("upserts the same VIN instead of duplicating it", async () => {
    await upsertVehicle(scan({ at: T1 }));
    const record = await upsertVehicle(scan({ at: T2, symbology: "code_128" }));

    expect(record.scanCount).toBe(2);
    expect(record.firstScannedAt).toBe(T1);
    expect(record.lastScannedAt).toBe(T2);
    expect(await db.vehicles.count()).toBe(1);
    expect(await db.scanEvents.count()).toBe(2);
  });

  it("keeps the earlier firstScannedAt when an import arrives out of order", async () => {
    await upsertVehicle(scan({ at: T2 }));
    const record = await upsertVehicle(scan({ at: T1, origin: "import", symbology: "import" }));

    expect(record.firstScannedAt).toBe(T1);
    expect(record.lastScannedAt).toBe(T2);
    expect(record.origin).toBe("scan");
  });

  it("leaves metaUpdatedAt alone on a re-scan of an edited record", async () => {
    await upsertVehicle(scan({ at: T1 }));
    const edited = await setVehicleMeta(VIN, { unit: "TRK-118" });
    const rescanned = await upsertVehicle(scan({ at: T2 }));

    expect(rescanned.metaUpdatedAt).toBe(edited.metaUpdatedAt);
    expect(rescanned.unit).toBe("TRK-118");
  });

  it("takes a non-empty unit from an import and keeps it through later scans", async () => {
    const imported = await upsertVehicle(
      scan({ at: T1, origin: "import", symbology: "import", unit: "TRK-204", notes: "spare key" }),
    );

    expect(imported.unit).toBe("TRK-204");
    expect(imported.notes).toBe("spare key");
    expect(imported.metaUpdatedAt).not.toBe(META_NEVER_EDITED);

    const rescanned = await upsertVehicle(scan({ at: T2, unit: "   " }));

    expect(rescanned.unit).toBe("TRK-204");
    expect(rescanned.notes).toBe("spare key");
    expect(rescanned.metaUpdatedAt).toBe(imported.metaUpdatedAt);
  });

  it("logs the symbology and raw text it was given", async () => {
    const raw = `  ${VIN}  `;
    await upsertVehicle(
      scan({ at: T1, symbology: "data_matrix", raw, checkDigitValid: false, deviceLabel: "Bay 3" }),
    );

    const events = await db.scanEvents.where("vin").equals(VIN).toArray();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      vin: VIN,
      at: T1,
      symbology: "data_matrix",
      raw,
      checkDigitValid: false,
      deviceLabel: "Bay 3",
    });
    expect(events[0]?.id).toBeTypeOf("string");
  });

  it("clears a tombstone when the VIN is scanned again", async () => {
    await upsertVehicle(scan({ at: T1 }));
    await db.vehicles.update(VIN, { deletedAt: T1 });

    const record = await upsertVehicle(scan({ at: T2 }));

    expect(record.deletedAt).toBeNull();
  });
});

describe("setVehicleMeta", () => {
  it("sets the unit and stamps the device clock", async () => {
    await upsertVehicle(scan({ at: T1 }));
    const record = await setVehicleMeta(VIN, { unit: "TRK-118" });

    expect(record.unit).toBe("TRK-118");
    expect(record.notes).toBeNull();
    expect(record.metaUpdatedAt).not.toBe(META_NEVER_EDITED);
    expect(record.metaUpdatedAt).toMatch(ISO_WITH_OFFSET);
    expect((await db.vehicles.get(VIN))?.unit).toBe("TRK-118");
  });

  it("clears a field on an explicit empty value and leaves an absent one alone", async () => {
    await upsertVehicle(scan({ at: T1 }));
    await setVehicleMeta(VIN, { unit: "TRK-118", notes: "spare key" });
    const record = await setVehicleMeta(VIN, { unit: "" });

    expect(record.unit).toBeNull();
    expect(record.notes).toBe("spare key");
  });

  it("rejects a VIN it has never seen", async () => {
    await expect(setVehicleMeta(VIN, { unit: "TRK-118" })).rejects.toThrow(VIN);
  });
});
