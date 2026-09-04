/**
 * §13.2 adversary tests for the §6.3 scanner state machine, round 1 of `harden S1`.
 *
 * Everything here is hostile input aimed at the machine's two time windows and at the
 * states in which a decode is honoured. Tests named `[A-…]` carry a finding id from the
 * round-1 ledger; a failure is the finding, not a flake.
 */

import { describe, expect, it } from "vitest";

import { COOLDOWN_MS, CONFIRM_WINDOW_MS, initialScanMachine, scanReducer } from "./scanMachine";
import type { ScanAction, ScanMachine, ScanSighting } from "./scanMachine";

const VIN_A = "1HGCM82633A004352";
const VIN_B = "1HGCM826X3A004350";
const VIN_C = "5FNRL38209B012345";

function sighting(vin: string, atMs: number, over: Partial<ScanSighting> = {}): ScanSighting {
  return { vin, raw: vin, checkDigitValid: true, symbology: "code_39", atMs, ...over };
}

function saw(vin: string, atMs: number, over: Partial<ScanSighting> = {}): ScanAction {
  return { type: "decoded", sighting: sighting(vin, atMs, over) };
}

const MOUNT: ScanAction = { type: "mount", secureContext: true };
const STARTED: ScanAction = { type: "stream_started" };

function run(actions: ScanAction[], from: ScanMachine = initialScanMachine): ScanMachine {
  return actions.reduce(scanReducer, from);
}

function streaming(): ScanMachine {
  return run([MOUNT, STARTED]);
}

describe("adversary — clock skew", () => {
  /**
   * §6.3: "the same VIN confirmed again within 10 s is ignored". A sighting whose
   * timestamp is *before* the acceptance is not within any forward window, but
   * `isCoolingDown` compares `atMs - acceptedAt <= COOLDOWN_MS` with no lower bound,
   * so an arbitrarily negative gap reads as "still cooling down". After a backwards
   * system-clock adjustment every VIN accepted this session becomes unscannable for
   * the whole duration of the jump, silently: the camera runs and never confirms.
   */
  it("[A-03] reads a VIN again when the clock jumped backwards past its acceptance", () => {
    const HOUR = 3_600_000;
    const accepted = run(
      [{ type: "accepted", vin: VIN_A, atMs: HOUR }, MOUNT, STARTED],
      streaming(),
    );
    // The device clock is corrected backwards by an hour; two honest reads follow.
    const machine = run([saw(VIN_A, 0), saw(VIN_A, 300)], accepted);
    expect(machine.state.kind).toBe("confirmed");
  });

  /**
   * The forward half of the same one-sided comparison: §6.3 confirms on "a second
   * identical normalized VIN within 1.5 s", but a second sighting a minute *earlier*
   * than the candidate also satisfies `atMs - candidate.atMs <= CONFIRM_WINDOW_MS`.
   */
  it("[A-03] does not confirm a sighting that predates the candidate by a minute", () => {
    const machine = run([saw(VIN_A, 60_000), saw(VIN_A, 0)], streaming());
    expect(machine.state.kind).toBe("candidate");
  });

  it("[A-03] still cools down a genuine repeat inside the window", () => {
    const accepted = run([{ type: "accepted", vin: VIN_A, atMs: 1000 }, MOUNT, STARTED]);
    expect(scanReducer(accepted, saw(VIN_A, 1000 + COOLDOWN_MS))).toBe(accepted);
    expect(scanReducer(accepted, saw(VIN_A, 1000))).toBe(accepted);
  });
});

describe("adversary — decodes while the camera is not running", () => {
  /**
   * §6.3 / S1 decision "Hiding the tab clears any pending candidate". The `hidden`
   * action drops the standing candidate, but `isLive` still reports `streaming` as
   * live, so an in-flight ZXing frame that lands after the tab went away builds a
   * fresh candidate while the camera is released. On return it can be confirmed by a
   * single new read — a scan taken while the phone was in a pocket.
   */
  it("[A-04] ignores a decode that lands after the tab went hidden", () => {
    const machine = run(
      [saw(VIN_A, 0), { type: "hidden", atMs: 100 }, saw(VIN_A, 150)],
      streaming(),
    );
    expect(machine.state).toEqual({ kind: "streaming" });
  });

  it("[A-04] cannot confirm across a hide from one read taken after it", () => {
    const machine = run(
      [
        saw(VIN_A, 0),
        { type: "hidden", atMs: 100 },
        // Late frame from the released stream.
        saw(VIN_A, 150),
        { type: "visible", atMs: 400, secureContext: true },
        // First honest read since the tab came back — must not be the second of a pair.
        saw(VIN_A, 500),
      ],
      streaming(),
    );
    expect(machine.state.kind).not.toBe("confirmed");
  });
});

describe("adversary — two-read agreement under hostile sequences", () => {
  it("never confirms a VIN seen only once, however the reads interleave", () => {
    const machine = run(
      [
        saw(VIN_A, 0),
        saw(VIN_B, 50),
        saw(VIN_C, 100),
        saw(VIN_A, 150),
        saw(VIN_B, 200),
        saw(VIN_C, 250),
        saw(VIN_A, 300),
      ],
      streaming(),
    );
    expect(machine.state).toEqual({ kind: "candidate", sighting: sighting(VIN_A, 300) });
  });

  it("confirms only the VIN that repeated, not the one that alternated around it", () => {
    const machine = run([saw(VIN_A, 0), saw(VIN_B, 10), saw(VIN_B, 20)], streaming());
    expect(machine.state).toEqual({ kind: "confirmed", sighting: sighting(VIN_B, 20) });
  });

  it("treats the confirmation window as inclusive on both sides of the bound", () => {
    expect(run([saw(VIN_A, 0), saw(VIN_A, CONFIRM_WINDOW_MS)], streaming()).state.kind).toBe(
      "confirmed",
    );
    expect(run([saw(VIN_A, 0), saw(VIN_A, CONFIRM_WINDOW_MS + 1)], streaming()).state.kind).toBe(
      "candidate",
    );
  });

  it("never confirms out of a torn-down machine", () => {
    const torn = run([{ type: "accepted", vin: VIN_A, atMs: 0 }], streaming());
    const machine = run([saw(VIN_B, 20_000), saw(VIN_B, 20_100)], torn);
    expect(machine.state).toEqual({ kind: "idle", lost: false });
  });
});
