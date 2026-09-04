/**
 * §9-S4's DoD extras, run end to end.
 *
 * **Read this before believing any of it.** There is no Docker daemon and no reachable
 * Supabase in this environment, so every scenario below runs against
 * `supabaseFake.testutil.ts` — an in-memory transcription of
 * `supabase/migrations/0001_init.sql`. That makes each result a claim about the client
 * protocol and about the transcription, not a claim about Postgres, PostgREST or GoTrue.
 * The device matrix in §7 item 4 and a real `supabase start` are what settle those, and the
 * session report says so.
 *
 * What these scenarios do settle is the part a server could not: that the outbox drains in
 * the order the user created it in, that a merge run twice lands where a merge run once
 * lands, and that no interleaving of an edit with a pull erases what someone typed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../storage/db";
import { setVehicleMeta, softDeleteVehicle, upsertVehicle } from "../storage/upsert";
import { createSyncEngine } from "./engine";
import { pullOnce } from "./pull";
import { pushOutbox } from "./push";
import { FakeServer, createFakeClient } from "./supabaseFake.testutil";
import type { SyncClient, SyncDeps } from "./types";

const VIN = "1HGCM82633A004352";
const VIN_B = "1FUJGLDR49SAV1234";
const VIN_C = "1HTMMAAL67H412345";
const USER = "11111111-1111-4111-8111-111111111111";
const INTRUDER = "22222222-2222-4222-8222-222222222222";
const YEAR = 2026;

let server: FakeServer;
let client: SyncClient;
let online: boolean;

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
  server = new FakeServer();
  client = createFakeClient(server, () => USER);
  online = true;
  vi.stubGlobal("navigator", {
    get onLine() {
      return online;
    },
  });
});

function deps(): SyncDeps {
  return { getClient: () => client, getUserId: async () => USER };
}

async function scan(vin: string): Promise<void> {
  await upsertVehicle({
    vin,
    origin: "scan",
    symbology: "code_39",
    raw: vin,
    checkDigitValid: true,
  });
}

function vehicle(vin: string) {
  return server.vehiclesOf(USER).find((row) => row.vin === vin);
}

describe("an offline day, flushed in order on reconnect", () => {
  it("sends every scan and the edit that followed them, then reports Synced", async () => {
    const engine = createSyncEngine(deps(), { currentYear: YEAR });
    online = false;

    await scan(VIN);
    await scan(VIN_B);
    await scan(VIN_C);
    await scan(VIN); // the same truck again, later in the day
    await setVehicleMeta(VIN, { unit: "TRK-118", notes: "no signal in the pit" });

    expect((await engine.sync()).status).toBe("offline");
    expect(server.requests).toHaveLength(0);
    const queued = await db.outbox.count();
    expect(queued).toBe(9); // four scans (event + meta each) and one edit

    online = true;
    const snapshot = await engine.sync();

    expect(snapshot).toMatchObject({ status: "synced", pending: 0 });
    expect(server.eventsOf(USER)).toHaveLength(4);
    expect(vehicle(VIN)).toMatchObject({ scan_count: 2, unit: "TRK-118" });
    expect(vehicle(VIN_B)?.scan_count).toBe(1);
    expect(vehicle(VIN_C)?.scan_count).toBe(1);
  });
});

describe("a push that half fails, and the retry that finishes it", () => {
  it("keeps what failed, sends what did not, and lands everything on the next cycle", async () => {
    const engine = createSyncEngine(deps(), { currentYear: YEAR });
    await scan(VIN);
    await scan(VIN_B);

    // The radio dies partway through the drain: the first request lands, the rest do not.
    let sent = 0;
    server.failNext = () => {
      sent += 1;
      return sent === 1 ? null : { message: "Failed to fetch", code: null };
    };
    const partial = await engine.sync();

    expect(partial.status).toBe("error");
    expect(server.requests.length).toBeGreaterThan(1);
    // Something reached the account — which row it was depends on the order two writes in
    // one millisecond happen to take (§5.7 has no sequence field), and nothing here needs
    // to know. What matters is that the rest is still queued rather than lost.
    expect(server.vehiclesOf(USER).length).toBeGreaterThan(0);
    expect(await db.outbox.count()).toBeGreaterThan(0);

    // §4.12: rows are never dropped. Clear the failure, clear the backoff the way time
    // would, and the queue finishes.
    server.failNext = null;
    await db.outbox.toCollection().modify({ nextAttemptAt: null });
    const done = await engine.sync();

    expect(done).toMatchObject({ status: "synced", pending: 0 });
    expect(server.eventsOf(USER)).toHaveLength(2);
    expect(vehicle(VIN)?.scan_count).toBe(1);
    expect(vehicle(VIN_B)?.scan_count).toBe(1);
  });

  it("counts one scan when the same queue is pushed twice", async () => {
    await scan(VIN);
    const rows = await db.outbox.toArray();

    await pushOutbox({ client, userId: USER });
    // A retry that duplicated the queue — a second tab, or a crash between the request and
    // the removal. §4.12's client-generated id is what makes this safe.
    await db.outbox.bulkPut(rows);
    await pushOutbox({ client, userId: USER });

    expect(server.eventsOf(USER)).toHaveLength(1);
    expect(vehicle(VIN)?.scan_count).toBe(1);
  });
});

describe("a pull that arrives mid-push", () => {
  it("does not erase the edit the user made while the last one was still in flight", async () => {
    await scan(VIN);
    await setVehicleMeta(VIN, { unit: "TRK-1" });
    await pushOutbox({ client, userId: USER });
    await pullOnce({ client, currentYear: YEAR });
    expect(vehicle(VIN)?.unit).toBe("TRK-1");

    // The user types again. The account still holds TRK-1, and its `meta_updated_at` is
    // older than this edit — so a pull that lands before the push must leave TRK-2 alone.
    await setVehicleMeta(VIN, { unit: "TRK-2" });
    await pullOnce({ client, currentYear: YEAR });

    expect((await db.vehicles.get(VIN))?.unit).toBe("TRK-2");
    expect(await db.outbox.count()).toBe(1);

    // And with the two genuinely interleaved, both sides still land on the later edit.
    await Promise.all([
      pushOutbox({ client, userId: USER }),
      pullOnce({ client, currentYear: YEAR }),
    ]);
    await pullOnce({ client, currentYear: YEAR });

    expect(vehicle(VIN)?.unit).toBe("TRK-2");
    expect((await db.vehicles.get(VIN))?.unit).toBe("TRK-2");
  });
});

describe("two devices editing the same unit", () => {
  it("converges on the later edit, whichever device pushes first", async () => {
    const engine = createSyncEngine(deps(), { currentYear: YEAR });
    await scan(VIN);
    await engine.sync();

    // Both clocks are derived from the record's own, because `apply_scan_event` seeds
    // `meta_updated_at` from the *event* clock (§4.12's literal skeleton, left as written):
    // a fixed timestamp older than the scan would lose to the scan rather than to the
    // other device, and the test would be measuring the quirk instead of the merge.
    const scanned = Date.parse((await db.vehicles.get(VIN))!.metaUpdatedAt);
    const phoneAt = new Date(scanned + 60 * 60 * 1000).toISOString();
    const laptopAt = new Date(scanned + 2 * 60 * 60 * 1000).toISOString();

    // This phone types an hour after the scan. The laptop types an hour after that, and
    // pushes first.
    await setVehicleMeta(VIN, { unit: "PHONE" });
    await db.outbox
      .where("kind")
      .equals("vehicle_meta")
      .modify({
        payload: {
          p_vin: VIN,
          p_unit: "PHONE",
          p_notes: null,
          p_meta_updated_at: phoneAt,
          p_structural: {},
          p_decode: {},
        },
      });
    await db.vehicles.where("vin").equals(VIN).modify({ unit: "PHONE", metaUpdatedAt: phoneAt });

    const laptop = createFakeClient(server, () => USER);
    await laptop.rpc("upsert_vehicle_meta", {
      p_vin: VIN,
      p_unit: "LAPTOP",
      p_notes: null,
      p_meta_updated_at: laptopAt,
      p_structural: {},
      p_decode: {},
    });

    await engine.sync();

    // The later edit wins on both sides, and the earlier one does not come back.
    expect(vehicle(VIN)?.unit).toBe("LAPTOP");
    expect((await db.vehicles.get(VIN))?.unit).toBe("LAPTOP");

    await engine.sync();
    expect((await db.vehicles.get(VIN))?.unit).toBe("LAPTOP");
  });
});

describe("a delete followed by a re-scan", () => {
  it("leaves the record alive on both sides", async () => {
    const engine = createSyncEngine(deps(), { currentYear: YEAR });
    await scan(VIN);
    await engine.sync();

    await softDeleteVehicle(VIN);
    await scan(VIN); // the truck came back through the gate
    await engine.sync();

    expect(vehicle(VIN)).toMatchObject({ deleted_at: null, scan_count: 2 });
    expect((await db.vehicles.get(VIN))?.deletedAt).toBeNull();
  });

  it("propagates a delete that is not followed by a scan", async () => {
    const engine = createSyncEngine(deps(), { currentYear: YEAR });
    await scan(VIN);
    await engine.sync();

    await softDeleteVehicle(VIN);
    await engine.sync();

    expect(vehicle(VIN)?.deleted_at).not.toBeNull();
    expect((await db.vehicles.get(VIN))?.deletedAt).not.toBeNull();
  });

  it("does not resurrect a record whose delete has not been pushed yet", async () => {
    const engine = createSyncEngine(deps(), { currentYear: YEAR });
    await scan(VIN);
    await engine.sync();

    online = false;
    await softDeleteVehicle(VIN);
    await engine.sync();

    // The account still shows it alive, and a pull must not undo what the user just did.
    online = true;
    await pullOnce({ client, currentYear: YEAR });
    expect((await db.vehicles.get(VIN))?.deletedAt).not.toBeNull();

    await engine.sync();
    expect(vehicle(VIN)?.deleted_at).not.toBeNull();
  });
});

describe("another account's rows (RLS — the model of it)", () => {
  it("cannot be read or written by a second user", async () => {
    await scan(VIN);
    await pushOutbox({ client, userId: USER });

    const intruderClient = createFakeClient(server, () => INTRUDER);
    const read = await intruderClient.from("vehicles").select("*").limit(500);
    expect(read.data).toEqual([]);

    const write = await intruderClient.from("scan_events").upsert(
      [
        {
          id: "stolen",
          user_id: USER,
          vin: VIN,
          at: "2026-09-04T06:00:00.000-06:00",
          symbology: "code_39",
          check_digit_valid: true,
          device_label: null,
          origin: "scan",
        },
      ],
      { onConflict: "id", ignoreDuplicates: true },
    );
    expect(write.error?.code).toBe("42501");
    expect(server.eventsOf(INTRUDER)).toHaveLength(0);
    expect(server.eventsOf(USER)).toHaveLength(1);
    // The real proof is `supabase/tests/10_rls_test.sql` against a real Postgres; this one
    // only says the client protocol never asks for anything RLS would have to refuse.
  });
});
