/**
 * [M10] `visible` with no `hidden` behind it.
 *
 * `scanMachine.ts:184` reads `machine.hiddenAtMs === null ? 0 : action.atMs - machine.hiddenAtMs`,
 * and `bun run mutate` forces that test false and survives. Nothing in the suite feeds the
 * machine a `visible` while `hiddenAtMs` is null and the state is live, so the arm that
 * says "no recorded hide means no elapsed time" is never exercised.
 *
 * It is not a hypothetical arm. `mount` and `retry` both clear `hiddenAtMs` (the machine's
 * own §6.3 contract), and `useScanner` subscribes to `visibilitychange` per `enabled` — so
 * a `visible` can be delivered against a machine that has no recorded hide: the listener
 * was not attached when the tab went away, or the platform delivered the restore without
 * the matching hide. With the guard gone the subtraction is `action.atMs - null`, which is
 * `action.atMs` — a wall-clock stamp, about 1.8e12, permanently past §6.3's 30 s window. So
 * every such event would restart the camera from `requesting`: a standing candidate is
 * dropped, the preview tears down and comes back, and the two-read agreement §6.3 depends
 * on has to start over. It is the difference between "nothing happened" and "the scanner
 * restarted itself", and no test could tell them apart.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  HIDDEN_LOST_MS,
  initialScanMachine,
  scanReducer,
  type ScanMachine,
  type ScanMachineState,
  type ScanSighting,
} from "./scanMachine";

const VIN_A = "1HGCM82633A004352";

/** A wall clock: an absolute stamp is six orders of magnitude larger than any §6.3 window. */
const EPOCH = Date.UTC(2026, 8, 5, 12, 0, 0);

function sighting(atMs: number): ScanSighting {
  return { vin: VIN_A, raw: VIN_A, checkDigitValid: true, symbology: "code_39", atMs };
}

function machineIn(state: ScanMachineState): ScanMachine {
  return { ...initialScanMachine, state };
}

describe("[M10] §6.3: a `visible` with nothing hidden before it is not an elapsed hide", () => {
  it("leaves a streaming machine streaming", () => {
    const before = machineIn({ kind: "streaming" });
    expect(before.hiddenAtMs).toBeNull();

    const after = scanReducer(before, { type: "visible", atMs: EPOCH, secureContext: true });

    // Not `requesting`: nothing was hidden, so nothing timed out, so the camera that is
    // already running keeps running.
    expect(after.state).toEqual({ kind: "streaming" });
    expect(after.hiddenAtMs).toBeNull();
  });

  it("keeps a standing candidate, which a restart would throw away", () => {
    const held = sighting(EPOCH - 400);
    const before = machineIn({ kind: "candidate", sighting: held });

    const after = scanReducer(before, { type: "visible", atMs: EPOCH, secureContext: true });

    // §6.3 gives agreement 1.5 s. A camera restart here costs the read 400 ms into that
    // window, and the second frame that would have confirmed it arrives at a machine in
    // `requesting`, which drops decodes.
    expect(after.state).toEqual({ kind: "candidate", sighting: held });
  });

  it("does not turn a live machine into a permission prompt on an insecure origin", () => {
    // The other half of the same line: `cameraStart(false)` is `error(insecure_context)`.
    // A machine that is already streaming has a camera, so a `visible` cannot be the thing
    // that decides the context is insecure.
    const before = machineIn({ kind: "streaming" });

    const after = scanReducer(before, { type: "visible", atMs: EPOCH, secureContext: false });

    expect(after.state).toEqual({ kind: "streaming" });
  });

  it("still re-requests when a real hide ran past §6.3's 30 s", () => {
    // The control: with a recorded hide, the same event does restart the camera. If this
    // and the cases above ever agree, the window has stopped being measured.
    const before: ScanMachine = {
      ...machineIn({ kind: "streaming" }),
      hiddenAtMs: EPOCH - HIDDEN_LOST_MS - 1,
    };

    const after = scanReducer(before, { type: "visible", atMs: EPOCH, secureContext: true });

    expect(after.state).toEqual({ kind: "requesting" });
    expect(after.hiddenAtMs).toBeNull();
  });

  it("holds for every live state and every wall-clock stamp", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ScanMachineState>(
          { kind: "requesting" },
          { kind: "streaming" },
          { kind: "candidate", sighting: sighting(EPOCH) },
          { kind: "confirmed", sighting: sighting(EPOCH) },
          { kind: "error", error: "stream_lost" },
        ),
        // Anything from "the epoch" to a clock two years fast, which is the range a device
        // clock can actually take, and every value of it is > HIDDEN_LOST_MS.
        fc.integer({ min: HIDDEN_LOST_MS + 1, max: EPOCH + 63_072_000_000 }),
        fc.boolean(),
        (state, atMs, secureContext) => {
          const before = machineIn(state);
          const after = scanReducer(before, { type: "visible", atMs, secureContext });
          // §6.3 moves on `visible` only when a hide expired or the machine was idle;
          // neither is true here, whatever the clock reads.
          expect(after.state).toEqual(state);
          expect(after.hiddenAtMs).toBeNull();
        },
      ),
      { seed: 0x5c9_0010, numRuns: 500 },
    );
  });

  it("re-requests from idle, hide or no hide, because idle has no camera", () => {
    // The one live exception §6.3 names: "a machine that is already idle (a dead track, a
    // saved scan) re-requests down the same path".
    const after = scanReducer(machineIn({ kind: "idle", lost: true }), {
      type: "visible",
      atMs: EPOCH,
      secureContext: true,
    });

    expect(after.state).toEqual({ kind: "requesting" });
  });
});
