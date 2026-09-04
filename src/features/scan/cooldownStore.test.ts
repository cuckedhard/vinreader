/**
 * The store behind the §6.3 cooldown ("the same VIN confirmed again within 10 s is ignored —
 * prevents double-logging on return to Scan").
 *
 * It is module state on purpose: the return to Scan that §6.3 names is a fresh React mount,
 * so a map held in component state is destroyed at exactly the moment the rule has to bite
 * (round-1 A-02). `scanMachine.test.ts` proves the seam — a hand-seeded store cools a VIN
 * down on a freshly built machine. What no test states is the store's own contract, and both
 * halves of it decide field behaviour:
 *
 *  - `read` hands out a copy. If it handed out the live map, the reducer's `{ ...cooldown }`
 *    would still look right while `startingScanMachine` leaked a writable view of module
 *    state to every caller.
 *  - `record` overwrites. A second acceptance of the same VIN has to move the window;
 *    keeping the first anchor would make a VIN scanned twice go quiet for no time at all,
 *    and appending would make it grow without bound.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cooldownStore } from "./cooldownStore";
import { COOLDOWN_MS, scanReducer, startingScanMachine } from "./scanMachine";
import type { ScanAction, ScanMachine } from "./scanMachine";

/** §4.11 fixtures. */
const VIN_A = "1HGCM82633A004352";
const VIN_B = "1HGCM826X3A004350";

/** A device clock, not a counter: `useScanner` stamps every entry with `Date.now()`. */
const EPOCH = Date.UTC(2026, 8, 4, 12, 0, 0);

const MOUNT: ScanAction = { type: "mount", secureContext: true };
const STARTED: ScanAction = { type: "stream_started" };

function saw(vin: string, atMs: number): ScanAction {
  return {
    type: "decoded",
    sighting: { vin, raw: vin, checkDigitValid: true, symbology: "code_39", atMs },
  };
}

function run(actions: ScanAction[], from: ScanMachine): ScanMachine {
  return actions.reduce(scanReducer, from);
}

/** What `useScanner.accept` does: the store and the machine take the same instant. */
function accept(machine: ScanMachine, vin: string, atMs: number): ScanMachine {
  cooldownStore.record(vin, atMs);
  return scanReducer(machine, { type: "accepted", vin, atMs });
}

beforeEach(() => {
  cooldownStore.clear();
});
afterEach(() => {
  cooldownStore.clear();
});

describe("cooldownStore — the contract", () => {
  it("starts empty, so a first scan of the session is never cooled down", () => {
    expect(cooldownStore.read()).toEqual({});
  });

  it("reads back what was recorded, keyed by VIN", () => {
    cooldownStore.record(VIN_A, EPOCH);
    cooldownStore.record(VIN_B, EPOCH + 7);
    expect(cooldownStore.read()).toEqual({ [VIN_A]: EPOCH, [VIN_B]: EPOCH + 7 });
  });

  it("hands out a copy, so no caller can write through to module state", () => {
    cooldownStore.record(VIN_A, EPOCH);
    const first = cooldownStore.read();
    first[VIN_A] = 0;
    first[VIN_B] = 0;
    delete first[VIN_A];
    expect(cooldownStore.read()).toEqual({ [VIN_A]: EPOCH });
    // Two reads are two objects: a caller holding an older snapshot cannot see a later
    // acceptance appear underneath it mid-render.
    expect(cooldownStore.read()).not.toBe(first);
    expect(cooldownStore.read()).not.toBe(cooldownStore.read());
  });

  it("moves the window to the latest acceptance of the same VIN", () => {
    cooldownStore.record(VIN_A, EPOCH);
    cooldownStore.record(VIN_A, EPOCH + 50_000);
    expect(cooldownStore.read()).toEqual({ [VIN_A]: EPOCH + 50_000 });
  });

  it("cools a re-accepted VIN from the second acceptance, not the first", () => {
    cooldownStore.record(VIN_A, EPOCH);
    cooldownStore.record(VIN_A, EPOCH + 50_000);
    const machine = run([MOUNT, STARTED], startingScanMachine());
    // The discriminating instant: long past the first window, five seconds into the second.
    // Under the first anchor this read is honoured, under the second it is ignored — so an
    // acceptance that failed to overwrite would let the scanner log one vehicle twice.
    const at = EPOCH + 55_000;
    expect(at - EPOCH).toBeGreaterThan(COOLDOWN_MS);
    expect(at - (EPOCH + 50_000)).toBeLessThan(COOLDOWN_MS);
    expect(scanReducer(machine, saw(VIN_A, at))).toBe(machine);
    expect(scanReducer(machine, saw(VIN_A, EPOCH + 50_000 + COOLDOWN_MS + 1)).state.kind).toBe(
      "candidate",
    );
  });

  it("keeps one VIN's window from touching another's", () => {
    cooldownStore.record(VIN_A, EPOCH);
    const machine = run([MOUNT, STARTED], startingScanMachine());
    expect(scanReducer(machine, saw(VIN_A, EPOCH + 1))).toBe(machine);
    expect(scanReducer(machine, saw(VIN_B, EPOCH + 1)).state.kind).toBe("candidate");
  });

  it("clears, which is what keeps module state from leaking between tests", () => {
    cooldownStore.record(VIN_A, EPOCH);
    cooldownStore.clear();
    expect(cooldownStore.read()).toEqual({});
    expect(startingScanMachine().cooldown).toEqual({});
  });
});

describe("cooldownStore — across the navigation that ends a scan", () => {
  it("cools the accepted VIN down on the screen that replaces the one that scanned it", () => {
    // The whole point of the module: accepting navigates to the Sheet, ScanScreen unmounts,
    // and the next visit to /#/scan builds a brand new machine. The old machine is dropped
    // here on purpose — nothing carries over except the store.
    const scanned = accept(run([MOUNT, STARTED], startingScanMachine()), VIN_A, EPOCH);
    expect(scanned.state).toEqual({ kind: "idle", lost: false });

    const remounted = run([MOUNT, STARTED], startingScanMachine());
    expect(remounted.cooldown).toEqual({ [VIN_A]: EPOCH });
    // Still pointed at the same door-jamb label, one second later.
    expect(scanReducer(remounted, saw(VIN_A, EPOCH + 1_000))).toBe(remounted);
    expect(scanReducer(remounted, saw(VIN_A, EPOCH + COOLDOWN_MS))).toBe(remounted);
  });

  it("lets the same vehicle be scanned again once the window has passed", () => {
    // §6.3's cooldown is a debounce, not a block list: a second visit to the same vehicle is
    // a legitimate scan, and §5.3 upserts it.
    accept(run([MOUNT, STARTED], startingScanMachine()), VIN_A, EPOCH);
    const remounted = run([MOUNT, STARTED], startingScanMachine());
    const after = run(
      [saw(VIN_A, EPOCH + COOLDOWN_MS + 1), saw(VIN_A, EPOCH + COOLDOWN_MS + 300)],
      remounted,
    );
    expect(after.state.kind).toBe("confirmed");
  });

  it("does not cool down a read the user rejected, however many screens later", () => {
    // Rescan writes nothing, so nothing may reach the store: `useScanner.accept` is the only
    // caller, and only the write path calls it (round-1 N-02).
    const confirmed = run(
      [saw(VIN_A, EPOCH), saw(VIN_A, EPOCH + 200)],
      run([MOUNT, STARTED], startingScanMachine()),
    );
    expect(confirmed.state.kind).toBe("confirmed");
    scanReducer(confirmed, { type: "rescan" });
    expect(cooldownStore.read()).toEqual({});
    expect(startingScanMachine().cooldown).toEqual({});
  });
});
