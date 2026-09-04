/**
 * §13.2 adversary, round 3 of `harden S1`. The decode run a **scan** kicks off, against
 * the decode run §5.4's own triggers are already driving.
 *
 * §4.7: "one request per VIN ever (cache is permanent; a manual Refresh details button on
 * the sheet is the only way to re-fetch)". `startDecodeQueue` enforces that with an
 * in-flight guard and `decodeQueue.test.ts` pins it ("does not start a second run while
 * one is in flight"). The scan path does not go through that guard: `useVinCommit.kickDecode`
 * calls `runDecodeQueueOnce` directly (useVinCommit.ts:24) on every successful save, and
 * `Shell` wires `startDecodeQueue` for the lifetime of the app (Shell.tsx:11).
 *
 * Deterministic: the response is held on an explicit gate, never on a delay, so no
 * assertion here depends on how fast anything runs.
 *
 * Finding: [R3-A] — both tests FAIL today.
 *
 * [R3-Q] adds the third entry point to the same argument. R3-A's guard is per *pass*, and
 * `refreshDecode` cannot take it — a Refresh button that goes quiet whenever a background
 * pass happens to be running is a dead control (P7). The guard the two paths share is
 * per VIN instead, so the queue skips a VIN Refresh has out and Refresh joins the answer
 * already coming rather than opening a second connection for it (§4.7).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db";
import { refreshDecode, runDecodeQueueOnce, startDecodeQueue } from "./decodeQueue";
import { upsertVehicle } from "./upsert";
import { VPIC_ENDPOINT } from "../vpic/client";
import type { VpicRawResponse } from "../vpic/types";

const VIN_A = "1HGCM82633A004352";
const T_OLD = "2026-01-05T08:15:00.000-06:00";

/** Synthetic, hand-built to the §4.7 documented shape. Nothing here came off the wire. */
const OK_BODY: VpicRawResponse = {
  Count: 1,
  Message: "synthetic",
  SearchCriteria: null,
  Results: [{ ErrorCode: "0", Make: "HONDA", Model: "Accord", ModelYear: "2003" }],
};

const REAL: Record<string, PropertyDescriptor | undefined> = {
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  document: Object.getOwnPropertyDescriptor(globalThis, "document"),
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
};

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

/** Let pending Dexie work and awaited fetches drain without waiting on real timers. */
async function settle(turns = 10): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function vinOf(url: string): string {
  return url.slice(VPIC_ENDPOINT.length + 1).split("?")[0]!;
}

/** A fetch whose response is released by hand, so a request can be held open. */
function gatedFetch(body: () => VpicRawResponse) {
  const vins: string[] = [];
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const impl = (async (input: RequestInfo | URL): Promise<Response> => {
    vins.push(vinOf(String(input)));
    await gate;
    return new Response(JSON.stringify(body()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { vins, impl, release: (): void => open() };
}

const noSleep = async (): Promise<void> => {};
const stops: (() => void)[] = [];

beforeEach(async () => {
  await db.open();
  await Promise.all(db.tables.map((table) => table.clear()));
  defineGlobal("navigator", { onLine: true, userAgent: "vitest" });
  defineGlobal("document", { visibilityState: "visible" });
  defineGlobal("window", new EventTarget());
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
  for (const stop of stops.splice(0)) stop();
  for (const [name, descriptor] of Object.entries(REAL)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[name];
  }
});

describe("[R3-A] §4.7 one request per VIN, across both decode entry points", () => {
  it("does not re-request a VIN a running queue already has in flight", async () => {
    const network = gatedFetch(() => OK_BODY);
    const deps = { fetchImpl: network.impl, sleep: noSleep };

    // §5.4 trigger 1: the app is up, and the request for the one pending row is out.
    stops.push(startDecodeQueue(deps));
    await settle();
    expect(network.vins).toEqual([VIN_A]);

    // A scan lands while that request is still out. This is `kickDecode` verbatim
    // (useVinCommit.ts:24) — the guard inside `startDecodeQueue` is not in this path.
    const kicked = runDecodeQueueOnce(deps);
    await settle();
    network.release();
    await kicked;
    await settle();

    // FAILS today: ["1HGCM82633A004352", "1HGCM82633A004352"] — one VIN, two requests.
    // §4.7's budget is one request per VIN *ever*; the client spends up to 38 s on a bad
    // radio (10 s timeout x 3 attempts, 2 s + 6 s backoff), so the overlap is the field
    // case, not the edge case.
    expect(network.vins).toEqual([VIN_A]);
  });

  it("spends one attempt per failed round, not one per overlapping run", async () => {
    const network = gatedFetch(() => {
      throw new Error("connection refused");
    });
    const deps = { fetchImpl: network.impl, sleep: noSleep };

    stops.push(startDecodeQueue(deps));
    await settle();
    const kicked = runDecodeQueueOnce(deps);
    network.release();
    await kicked;
    await settle(20);

    // §5.4 gives a row ten attempts before it is written off as `failed` and drops out
    // of the automatic queue until the user finds "Refresh details". Two overlapping
    // runs spend two of the ten for one round of bad signal, so the row is written off
    // in half the rounds §5.4 allows. FAILS today: attempts is 2.
    expect((await db.vehicles.get(VIN_A))!.decode.attempts).toBe(1);
  });
});

describe("[R3-Q] §4.7 one request per VIN, with Refresh as the third entry point", () => {
  it("does not re-request a VIN Refresh already has in flight", async () => {
    const network = gatedFetch(() => OK_BODY);
    const deps = { fetchImpl: network.impl, sleep: noSleep };

    // The user is on the sheet and taps "Refresh details" (§4.7's one sanctioned
    // re-fetch); that request is out, against a row it has armed `pending`.
    const refreshed = refreshDecode(VIN_A, deps);
    await settle();
    expect(network.vins).toEqual([VIN_A]);

    // §5.4's poll comes round while it is still out and finds that pending row. R3-A's
    // pass-level guard is no help here: Refresh never took it. Started rather than
    // awaited, so a pass that does issue the second request is caught at the assertion
    // below instead of deadlocking on the gate this test still holds.
    const passed = runDecodeQueueOnce(deps);
    await settle();
    expect(network.vins).toEqual([VIN_A]);

    network.release();
    expect(await passed).toBe(0);
    await refreshed;
    await settle();

    // One VIN, one request, and the skipped row still got its answer.
    expect(network.vins).toEqual([VIN_A]);
    expect((await db.vehicles.get(VIN_A))!.decode.status).toBe("ok");
  });

  it("joins the request the queue has out rather than opening a second", async () => {
    const network = gatedFetch(() => OK_BODY);
    const deps = { fetchImpl: network.impl, sleep: noSleep };

    // §5.4 trigger 1: the app is up and the request for the pending row is out.
    stops.push(startDecodeQueue(deps));
    await settle();
    expect(network.vins).toEqual([VIN_A]);

    let landed = false;
    const refreshed = refreshDecode(VIN_A, deps).then(() => {
      landed = true;
    });
    await settle();
    expect(network.vins).toEqual([VIN_A]);
    // The tap is not silently dropped, which is the whole reason the guard is per VIN and
    // not per pass: it resolves when the answer lands, so the sheet's button stays busy
    // and then fills in front of the user (P7).
    expect(landed).toBe(false);

    network.release();
    await refreshed;

    expect(landed).toBe(true);
    expect(network.vins).toEqual([VIN_A]);
    expect((await db.vehicles.get(VIN_A))!.decode.status).toBe("ok");
  });

  it("makes one request out of two taps on the same VIN", async () => {
    const network = gatedFetch(() => OK_BODY);
    const deps = { fetchImpl: network.impl, sleep: noSleep };

    const first = refreshDecode(VIN_A, deps);
    await settle();
    const second = refreshDecode(VIN_A, deps);
    await settle();

    network.release();
    await Promise.all([first, second]);

    expect(network.vins).toEqual([VIN_A]);
    expect((await db.vehicles.get(VIN_A))!.decode.status).toBe("ok");
  });
});
