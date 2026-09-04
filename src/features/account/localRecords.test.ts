/**
 * §9-S4's first-sign-in merge, storage half — the three decisions the Account screen makes
 * about a phone's existing records, tested where they actually live.
 *
 * The one that would fail silently on a real phone is `armUploadPrompt`. §5.6 defaults
 * `syncEnabled` to true, so a device that has been scanning for a week signs in with a full
 * §5.7 queue and pushes all of it on the engine's first cycle. If the prompt is asked after
 * that, **Not now** is a button that undoes nothing and the user's records are in an account
 * they said they did not want them in — and every test that renders the prompt still passes.
 * So the gate closing *before* the session exists is asserted here, on the storage row that
 * decides it.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../../lib/storage/db";
import { getSettings, updateSettings } from "../../lib/storage/settings";
import { softDeleteVehicle, upsertVehicle, type UpsertInput } from "../../lib/storage/upsert";
import { addLocalRecords, armUploadPrompt, countLocalRecords, declineUpload } from "./localRecords";

const VIN_A = "1HGCM82633A004352"; // §4.11 fixture: grammar ok, check digit valid.
const VIN_B = "1FUJGLDR49SAV1234";

function scan(overrides: Partial<UpsertInput> = {}): UpsertInput {
  return {
    vin: VIN_A,
    origin: "scan",
    symbology: "code_39",
    raw: `I${VIN_A}`,
    checkDigitValid: true,
    ...overrides,
  };
}

/** A device that has been scanning while signed out: records, and a queue full of them. */
async function scanTwo(): Promise<void> {
  await upsertVehicle(scan());
  await upsertVehicle(scan({ vin: VIN_B, raw: `I${VIN_B}` }));
}

/** The state a "keep this phone's records" sign-out leaves behind (`signOutKeepRecords`). */
async function clearQueue(): Promise<void> {
  await db.outbox.clear();
}

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
});

describe("countLocalRecords — what 'the N records on this phone' means", () => {
  it("counts live records and not tombstones", async () => {
    await scanTwo();
    expect(await countLocalRecords()).toBe(2);

    // §5.1's `deletedAt`: a record the user deleted. Offering to upload it would be
    // offering to undo that.
    await softDeleteVehicle(VIN_B);
    expect(await countLocalRecords()).toBe(1);
  });

  it("is zero on a phone that has never scanned", async () => {
    expect(await countLocalRecords()).toBe(0);
  });
});

describe("armUploadPrompt — the gate shuts before the session opens", () => {
  it("clears syncEnabled when records are waiting and the question is unanswered", async () => {
    await scanTwo();
    expect((await getSettings()).syncEnabled).toBe(true); // §5.6's default

    expect(await armUploadPrompt()).toBe(true);

    // The whole point: the engine's first cycle after sign-in now finds the gate shut and
    // pushes nothing, so **Not now** still has something to decide (§5.6, §9-S4).
    expect((await getSettings()).syncEnabled).toBe(false);
    // And nothing was discarded — the rows are exactly where they were.
    expect(await db.outbox.count()).toBeGreaterThan(0);
  });

  it("asks nothing on a phone with no records, and leaves sync alone", async () => {
    expect(await armUploadPrompt()).toBe(false);
    expect((await getSettings()).syncEnabled).toBe(true);
  });

  it("asks nothing once the question has been answered", async () => {
    await scanTwo();
    await updateSettings({ uploadPromptDismissed: true, syncEnabled: true });

    expect(await armUploadPrompt()).toBe(false);
    // A user who already said yes keeps syncing; re-arming would silently switch them off.
    expect((await getSettings()).syncEnabled).toBe(true);
  });

  it("is idempotent when the gate is already shut", async () => {
    await scanTwo();
    await updateSettings({ syncEnabled: false });

    expect(await armUploadPrompt()).toBe(true);
    expect((await getSettings()).syncEnabled).toBe(false);
  });
});

describe("declineUpload — §6.4's Not now", () => {
  it("remembers the answer, shuts the gate, and discards nothing", async () => {
    await scanTwo();
    const queued = await db.outbox.count();

    await declineUpload();

    const settings = await getSettings();
    expect(settings.syncEnabled).toBe(false);
    expect(settings.uploadPromptDismissed).toBe(true);
    // §5.6: "Not now has to stop the push, not discard the rows."
    expect(await db.outbox.count()).toBe(queued);
  });
});

describe("addLocalRecords — §6.4's Add, and §6.2's 'Add N local records'", () => {
  it("opens the gate and queues nothing that is already queued", async () => {
    await scanTwo();
    await declineUpload();
    const before = await db.outbox.where("kind").equals("vehicle_meta").count();
    expect(before).toBe(2);

    expect(await addLocalRecords()).toBe(0);

    const settings = await getSettings();
    expect(settings.syncEnabled).toBe(true);
    expect(settings.uploadPromptDismissed).toBe(true);
    // A second row per VIN would be merged away by `upsert_vehicle_meta` and cost a round
    // trip to learn nothing.
    expect(await db.outbox.where("kind").equals("vehicle_meta").count()).toBe(before);
  });

  it("re-queues records the sign-out took the queue for (§9-S4, signOut.ts)", async () => {
    await scanTwo();
    await clearQueue();

    expect(await addLocalRecords()).toBe(2);

    const rows = await db.outbox.where("kind").equals("vehicle_meta").toArray();
    expect(rows.map((row) => row.vin).sort()).toEqual([VIN_B, VIN_A].sort());
    // §4.12: the three aggregates are derived by trigger and never pushed.
    for (const row of rows) {
      expect(row.payload).not.toHaveProperty("scan_count");
      expect(row.payload).toMatchObject({ p_vin: row.vin });
    }
  });

  it("leaves deleted records out of the upload", async () => {
    await scanTwo();
    await softDeleteVehicle(VIN_B);
    await clearQueue();

    expect(await addLocalRecords()).toBe(1);
    const rows = await db.outbox.where("kind").equals("vehicle_meta").toArray();
    expect(rows.map((row) => row.vin)).toEqual([VIN_A]);
  });

  it("queues the missing half when only some records are already queued", async () => {
    await scanTwo();
    await clearQueue();
    await upsertVehicle(scan()); // VIN_A scanned again: its rows are back in the queue

    expect(await addLocalRecords()).toBe(1);
    const vins = (await db.outbox.where("kind").equals("vehicle_meta").toArray()).map(
      (row) => row.vin,
    );
    expect(vins.filter((vin) => vin === VIN_A)).toHaveLength(1);
    expect(vins.filter((vin) => vin === VIN_B)).toHaveLength(1);
  });

  it("does nothing but open the gate on a phone with no records", async () => {
    await updateSettings({ syncEnabled: false, uploadPromptDismissed: true });

    expect(await addLocalRecords()).toBe(0);
    expect((await getSettings()).syncEnabled).toBe(true);
    expect(await db.outbox.count()).toBe(0);
  });
});
