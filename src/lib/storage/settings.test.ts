import { beforeEach, describe, expect, it } from "vitest";
import { db } from "./db";
import { clearAllData, DEFAULT_SETTINGS, getSettings, updateSettings } from "./settings";
import { upsertVehicle } from "./upsert";

const VIN = "1HGCM82633A004352";

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
});

describe("settings", () => {
  it("creates the row with the defaults on first read", async () => {
    expect(await db.settings.count()).toBe(0);

    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);

    expect(await db.settings.count()).toBe(1);
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("persists a patch and leaves the other fields alone", async () => {
    const updated = await updateSettings({ deviceLabel: "Bay 3", sound: false });

    expect(updated).toEqual({ ...DEFAULT_SETTINGS, deviceLabel: "Bay 3", sound: false });
    expect(await getSettings()).toEqual(updated);
    expect(await db.settings.count()).toBe(1);
  });
});

describe("clearAllData", () => {
  it("empties every table and restores the default settings", async () => {
    await upsertVehicle({
      vin: VIN,
      origin: "manual",
      symbology: "manual",
      raw: VIN,
      checkDigitValid: true,
    });
    await updateSettings({ deviceLabel: "Bay 3", uploadPromptDismissed: true });

    await clearAllData();

    expect(await db.vehicles.count()).toBe(0);
    expect(await db.scanEvents.count()).toBe(0);
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
