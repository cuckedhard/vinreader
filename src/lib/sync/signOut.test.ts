/**
 * §9-S4's two ways out. The difference between them is the whole of N7: signing out never
 * destroys local data without the user asking for it in as many words.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../storage/db";
import { DEFAULT_SETTINGS, updateSettings } from "../storage/settings";
import { advanceCursors, getSyncState } from "../storage/syncState";
import { upsertVehicle } from "../storage/upsert";
import { signOutClearDevice, signOutKeepRecords } from "./signOut";

const VIN = "1HGCM82633A004352";

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
  await upsertVehicle({
    vin: VIN,
    origin: "scan",
    symbology: "code_39",
    raw: VIN,
    checkDigitValid: true,
  });
  await advanceCursors({ vehiclesCursor: "2026-09-04T00:00:00.000Z" });
  await updateSettings({ deviceLabel: "Bay 3" });
});

describe("keep this phone's records", () => {
  it("leaves the records and the log, and clears the queue and the cursor", async () => {
    await signOutKeepRecords();

    expect(await db.vehicles.count()).toBe(1);
    expect(await db.scanEvents.count()).toBe(1);
    // The queued rows are addressed to the account that was signed in when they were
    // written; §9-S4's "Add N local records" is how they reach the next one.
    expect(await db.outbox.count()).toBe(0);
    const state = await getSyncState();
    expect(state.vehiclesCursor).toBeNull();
    expect(state.eventsCursor).toBeNull();
  });

  it("keeps this device's settings, which never synced anyway", async () => {
    await signOutKeepRecords();
    expect((await db.settings.get("settings"))?.deviceLabel).toBe("Bay 3");
  });
});

describe("clear this phone", () => {
  it("leaves no record, no event, no queue, no cursor and no device label", async () => {
    await signOutClearDevice();

    expect(await db.vehicles.count()).toBe(0);
    expect(await db.scanEvents.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect(await db.wmi.count()).toBe(0);
    expect(await db.settings.get("settings")).toEqual(DEFAULT_SETTINGS);
    expect(await getSyncState()).toMatchObject({
      id: "cursor",
      vehiclesCursor: null,
      eventsCursor: null,
      lastPushAt: null,
      lastPullAt: null,
      lastError: null,
    });
  });
});
