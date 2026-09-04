/**
 * The queue's seams, fixed under [R3-A], [R3-H] and [R3-Q] in round 3 of `harden S1`:
 *
 *  - the §4.7 in-flight guards — one per pass, one per VIN — now live on the module, so no
 *    caller can go around them; `decodeQueue.kick.test.ts` pins the overlaps themselves,
 *    and what is pinned here is the release, because a guard that stays set after a failed
 *    pass strands every unfilled sheet until the app is restarted;
 *  - `kickDecodeQueue`, the one kick every write path fires (§6.3 scan, §9-S3 import).
 *
 * Every vPIC body is SYNTHETIC, hand-built to the §4.7 shape. Nothing came off the wire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VPIC_ENDPOINT } from "../vpic/client";
import type { VpicDeps, VpicRawResponse } from "../vpic/types";
import { db } from "./db";
import { kickDecodeQueue, refreshDecode, runDecodeQueueOnce } from "./decodeQueue";
import { updateSettings } from "./settings";
import { upsertVehicle } from "./upsert";

const VIN_A = "1HGCM82633A004352";
const T_OLD = "2026-01-05T08:15:00.000-06:00";

const OK_BODY: VpicRawResponse = {
  Count: 1,
  Message: "synthetic",
  SearchCriteria: null,
  Results: [{ ErrorCode: "0", Make: "HONDA", Model: "Accord", ModelYear: "2003" }],
};

/** §5.5: a `Manufacturer` is what sends `applyDecodeResult` on to the `wmi` table. */
const WITH_MANUFACTURER: VpicRawResponse = {
  ...OK_BODY,
  Results: [{ ...OK_BODY.Results[0], Manufacturer: "AMERICAN HONDA MOTOR CO., INC." }],
};

interface FetchDouble {
  impl: typeof fetch;
  vins: string[];
}

function vinOf(url: string): string {
  return url.slice(VPIC_ENDPOINT.length + 1).split("?")[0];
}

function fetchDouble(body: VpicRawResponse = OK_BODY): FetchDouble {
  const vins: string[] = [];
  const impl = (async (input: RequestInfo | URL): Promise<Response> => {
    vins.push(vinOf(String(input)));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, vins };
}

/** Backoff waits are real seconds under §4.7; tests skip them. */
const noSleep = async (): Promise<void> => {};

function depsFor(double: FetchDouble): VpicDeps {
  return { fetchImpl: double.impl, sleep: noSleep };
}

const REAL: Record<string, PropertyDescriptor | undefined> = {
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  document: Object.getOwnPropertyDescriptor(globalThis, "document"),
};

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
  defineGlobal("navigator", { onLine: true, userAgent: "vitest" });
  defineGlobal("document", { visibilityState: "visible" });
  await upsertVehicle({
    vin: VIN_A,
    origin: "scan",
    symbology: "code_39",
    raw: VIN_A,
    checkDigitValid: true,
    at: T_OLD,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [name, descriptor] of Object.entries(REAL)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[name];
  }
});

describe("[R3-A] the in-flight guard releases", () => {
  it("lets the next trigger run after a pass threw", async () => {
    // IndexedDB is exactly what fails on a phone that is full or in a private window,
    // and §5.4's poll is the only thing that ever retries a pending decode.
    const double = fetchDouble();
    const where = vi.spyOn(db.vehicles, "where").mockImplementation(() => {
      throw new Error("IndexedDB unavailable");
    });

    await expect(runDecodeQueueOnce(depsFor(double))).rejects.toThrow("IndexedDB unavailable");

    where.mockRestore();
    expect(await runDecodeQueueOnce(depsFor(double))).toBe(1);
    expect(double.vins).toEqual([VIN_A]);
  });
});

/**
 * The same argument for the per-VIN entry [R3-Q] adds. A VIN left in that map is worse
 * than a stuck pass flag: the queue would skip it on every later pass and Refresh would
 * join a promise that settled long ago, so the row could never be decoded again this
 * session — and the button that exists to fix exactly that would be the dead control the
 * per-VIN guard was chosen to avoid (P7).
 *
 * The release after a *successful* request is pinned in `decodeQueue.test.ts`, where
 * "re-fetches a row that already decoded ok" spends a queue request and then a Refresh
 * request on one VIN. What is pinned here is the throwing request.
 */
describe("[R3-Q] the per-VIN in-flight entry releases", () => {
  /**
   * §5.5's WMI write shares `applyDecodeResult`'s transaction, so failing it aborts the
   * decode *after* the §4.7 request has been spent — the ordering that strands a VIN.
   */
  function breakStorageAfterTheRequest(): void {
    vi.spyOn(db.wmi, "put").mockImplementation(() => {
      throw new Error("IndexedDB unavailable");
    });
  }

  it("frees a VIN whose Refresh threw, so the next tap still reaches the network", async () => {
    const failed = fetchDouble(WITH_MANUFACTURER);
    breakStorageAfterTheRequest();

    await expect(refreshDecode(VIN_A, depsFor(failed))).rejects.toThrow("IndexedDB unavailable");
    expect(failed.vins).toEqual([VIN_A]);

    vi.restoreAllMocks();
    const retried = fetchDouble(WITH_MANUFACTURER);
    await refreshDecode(VIN_A, depsFor(retried));

    expect(retried.vins).toEqual([VIN_A]);
    expect((await db.vehicles.get(VIN_A))!.decode.status).toBe("ok");
  });

  it("frees a VIN whose queued request threw, so the next pass picks the row up", async () => {
    const failed = fetchDouble(WITH_MANUFACTURER);
    breakStorageAfterTheRequest();

    await expect(runDecodeQueueOnce(depsFor(failed))).rejects.toThrow("IndexedDB unavailable");
    expect(failed.vins).toEqual([VIN_A]);

    vi.restoreAllMocks();
    const retried = fetchDouble(WITH_MANUFACTURER);
    expect(await runDecodeQueueOnce(depsFor(retried))).toBe(1);

    expect(retried.vins).toEqual([VIN_A]);
    expect((await db.vehicles.get(VIN_A))!.decode.status).toBe("ok");
  });
});

describe("[R3-H] kickDecodeQueue, the seam every write path ends on", () => {
  it("decodes the row a save just left pending", async () => {
    const double = fetchDouble();

    await kickDecodeQueue(depsFor(double));

    expect(double.vins).toEqual([VIN_A]);
    expect((await db.vehicles.get(VIN_A))!.decode.status).toBe("ok");
  });

  it("requests nothing when §5.6 auto-decode is off", async () => {
    await updateSettings({ autoDecode: false });
    const double = fetchDouble();

    await kickDecodeQueue(depsFor(double));

    expect(double.vins).toEqual([]);
    expect((await db.vehicles.get(VIN_A))!.decode.status).toBe("pending");
  });

  it("never rejects, so a decode failure cannot surface as a save failure (N1)", async () => {
    const double = fetchDouble();
    vi.spyOn(db.vehicles, "where").mockImplementation(() => {
      throw new Error("IndexedDB unavailable");
    });

    await expect(kickDecodeQueue(depsFor(double))).resolves.toBeUndefined();
    expect(double.vins).toEqual([]);
  });
});
