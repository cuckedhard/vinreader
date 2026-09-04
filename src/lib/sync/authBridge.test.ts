/**
 * The glue between the two halves of S4, and the one property that matters about it: with
 * no `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — the build every user who never signs
 * in runs — starting sync is a no-op that touches nothing (N7).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "../storage/db";
import { upsertVehicle } from "../storage/upsert";
import { appSyncDeps, createAppSyncEngine, startAppSync } from "./authBridge";
import { getSyncEngine, stopSync } from "./engine";

const VIN = "1HGCM82633A004352";

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
});

afterEach(() => {
  stopSync();
});

describe("appSyncDeps", () => {
  it("hands the engine the three contract functions and nothing else", () => {
    const deps = appSyncDeps();
    expect(Object.keys(deps).sort()).toEqual(["getClient", "getUserId", "onAuthChange"]);
    // No env vars in a unit run, so there is no client — the normal signed-out build.
    expect(deps.getClient()).toBeNull();
  });

  it("reports no user when there is no client to ask", async () => {
    await expect(appSyncDeps().getUserId()).resolves.toBeNull();
  });

  it("subscribes and unsubscribes without a session", () => {
    const unwire = appSyncDeps().onAuthChange?.(() => {});
    expect(typeof unwire).toBe("function");
    unwire?.();
  });
});

describe("startAppSync", () => {
  it("runs a full cycle on an unconfigured build, leaving the queue untouched", async () => {
    await upsertVehicle({
      vin: VIN,
      origin: "scan",
      symbology: "code_39",
      raw: VIN,
      checkDigitValid: true,
    });

    const engine = startAppSync();
    expect(getSyncEngine()).toBe(engine);
    const snapshot = await engine.sync();

    expect(snapshot).toMatchObject({ status: "signed_out", pending: 2 });
    expect(await db.outbox.count()).toBe(2);
    stopSync();
  });

  it("builds an engine without starting it when the caller owns the lifecycle", async () => {
    const engine = createAppSyncEngine();
    expect(getSyncEngine()).toBeNull();
    expect((await engine.sync()).status).toBe("signed_out");
    engine.stop();
  });
});
