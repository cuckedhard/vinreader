/**
 * [FR-6] §6.4's "Couldn't read that code" is about the code in the frame, and the machine is
 * what knows when the frame has moved on.
 *
 * R3-F5 and FR-4 both put that knowledge in `ScanScreen`'s derivation instead, over a
 * `useState` the screen alone ever wrote: `carrierError !== null && refusal === null &&
 * state.kind !== "candidate" && state.kind !== "confirmed"`. The last two terms *suppress* the
 * banner rather than ending it, so every route back to `streaming` from a state that had
 * merely hidden it re-raised it — a notice about a code two codes ago (N2), beside nothing at
 * all. §6.3's `tick` is the cheapest of those routes and `tests/e2e/scan-carrier-then-lapse`
 * drives it end to end; `visible` after a hide past §6.3's window is another, and the reason
 * the fix is not a fourth term but a move: the rejection lives beside the refusal now, in the
 * one place that sees every read.
 *
 * None of this is a `ScanState` (§4.10 is a §4 constant, N6): the machine stays `streaming`
 * throughout, the camera is never stopped and nothing is ever written (N1).
 */
import { describe, expect, it } from "vitest";

import {
  CONFIRM_WINDOW_MS,
  HIDDEN_LOST_MS,
  initialScanMachine,
  scanReducer,
  type ScanAction,
  type ScanMachine,
  type ScanSighting,
} from "./scanMachine";
import { extractVinExplained } from "../../lib/vin/extractVin";
import type { NoVin } from "../../lib/vin/types";

const VIN = "1HGCM82633A004352";
/** The report's part number: decodes cleanly on every frame, and is not a VIN (§4.2). */
const PART = "R25-1251-200622120";
const EPOCH = Date.UTC(2026, 8, 8, 12, 0, 0);

/** A §4.9 URL carrier, as the decoder hands it over. */
const CODE = "https://vinrelay.example/#/i?d=eyJ2IjoyLCJ2aW4iOiIxSEdDTTgyNjMzQTAwNDM1MiJ9";
/** A second one, off a different phone. */
const OTHER = "VINRELAY2:eyJ2IjoyLCJ2aW4iOiIxSEdDTTgyNjMzQTAwNDM1MiJ9";
/** §6.4's body for it — the codec's own sentence, which the screen passes through (P6). */
const REJECTION = "This payload is version 2; this app reads version 1.";

const MOUNT: ScanAction = { type: "mount", secureContext: true };
const STARTED: ScanAction = { type: "stream_started" };

/** A §4.9 code in the frame, with what the screen made of it (`null` = it took the code). */
function carrier(raw: string, message: string | null): ScanAction {
  return { type: "carrier", raw, message };
}

function refusalOf(raw: string): NoVin {
  const outcome = extractVinExplained(raw);
  if (outcome.ok) throw new Error(`expected NO_VIN, got ${outcome.result.vin}`);
  return outcome.refusal;
}

function refused(raw: string, atMs: number): ScanAction {
  return { type: "refused", refusal: refusalOf(raw), atMs };
}

function sighting(vin: string, atMs: number): ScanSighting {
  return { vin, raw: vin, checkDigitValid: true, symbology: "code_128", atMs };
}

function run(actions: ScanAction[], from: ScanMachine = initialScanMachine): ScanMachine {
  return actions.reduce(scanReducer, from);
}

function streaming(): ScanMachine {
  return run([MOUNT, STARTED]);
}

/** A machine holding §6.4's rejection for `CODE`. */
function rejecting(): ScanMachine {
  const machine = scanReducer(streaming(), carrier(CODE, REJECTION));
  expect(machine.carrierError).toEqual({ raw: CODE, message: REJECTION });
  return machine;
}

describe("[FR-6] the carrier's rejection is the machine's, beside the refusal", () => {
  it("holds what the screen could not read, and moves no state for it (N1, N6)", () => {
    const machine = rejecting();
    // §4.10 gains nothing: a rejection owns neither the camera nor the status line, exactly
    // as a refusal does not, and the stream is never stopped for one.
    expect(machine.state).toEqual({ kind: "streaming" });
    expect(machine.cooldown).toEqual({});
    // The raw text comes with it, so a dismissal can be about *that code* (R3-F5).
    expect(machine.carrierError?.raw).toBe(CODE);
  });

  it("holds nothing for a code the screen took", () => {
    // A readable carrier is handed to Import and there is nothing to say about it.
    const taken = scanReducer(streaming(), carrier(CODE, null));
    expect(taken.carrierError).toBeNull();
    // And it ends a rejection that was standing: whatever this code is, the last one is not
    // what the camera is looking at any more.
    expect(scanReducer(rejecting(), carrier(OTHER, null)).carrierError).toBeNull();
  });

  it("is ended by a VIN in the frame, and a lapsed candidate cannot bring it back", () => {
    // The finding, in the reducer. One frame of a label moves the machine to `candidate`,
    // which is all that used to take the banner off the screen (R3-F5's state guard) —
    // ending it there is the difference between suppressing and clearing.
    const seen = scanReducer(rejecting(), { type: "decoded", sighting: sighting(VIN, EPOCH) });
    expect(seen.state.kind).toBe("candidate");
    expect(seen.carrierError).toBeNull();

    // §6.3's window runs out with no second frame agreeing, and the machine goes back to
    // `streaming`. Before the fix this is the instant the rejection reappeared, about a code
    // two codes ago and with nothing in front of the camera (N2).
    const lapsed = scanReducer(seen, { type: "tick", atMs: EPOCH + CONFIRM_WINDOW_MS + 1 });
    expect(lapsed.state).toEqual({ kind: "streaming" });
    expect(lapsed.carrierError).toBeNull();
  });

  it("is ended by every restart of the camera, the long hide's re-request included", () => {
    for (const action of [MOUNT, { type: "retry", secureContext: true } as ScanAction]) {
      expect(scanReducer(rejecting(), action).carrierError, action.type).toBeNull();
    }

    // The second door the finding named: `visible` past §6.3's hidden window re-requests the
    // camera, and it used to spread `NO_REFUSAL` with the rejection still standing.
    const back = run(
      [
        { type: "hidden", atMs: EPOCH },
        { type: "visible", atMs: EPOCH + HIDDEN_LOST_MS + 1, secureContext: true },
      ],
      rejecting(),
    );
    expect(back.state).toEqual({ kind: "requesting" });
    expect(back.carrierError).toBeNull();
  });

  it("survives a short hide, which is the same scene coming back", () => {
    // Nothing was written, so there is nothing to take: the code is still under the camera
    // and the answer to it is still true. The same rule the refusal is read under.
    const back = run(
      [
        { type: "hidden", atMs: EPOCH },
        { type: "visible", atMs: EPOCH + 100, secureContext: true },
      ],
      rejecting(),
    );
    expect(back.state).toEqual({ kind: "streaming" });
    expect(back.carrierError?.raw).toBe(CODE);
  });

  it("is never raised by a frame from a stream that is not live", () => {
    // A late frame out of ZXing's already-queued timer describes a scene nobody is pointing
    // at — the same guard `refused` and `decoded` are read under.
    expect(scanReducer(initialScanMachine, carrier(CODE, REJECTION)).carrierError).toBeNull();

    const hidden = scanReducer(streaming(), { type: "hidden", atMs: EPOCH });
    expect(scanReducer(hidden, carrier(CODE, REJECTION)).carrierError).toBeNull();
  });

  it("is the same machine when the same code decodes again", () => {
    // The code in front of the camera decodes several times a second. A fresh machine per
    // frame would re-render the screen at the decode rate for no change — the property
    // R3-F5's `setState` of an identical string used to keep on this path.
    const standing = rejecting();
    expect(scanReducer(standing, carrier(CODE, REJECTION))).toBe(standing);
    // Nothing to raise and nothing to clear is identical too.
    const quiet = streaming();
    expect(scanReducer(quiet, carrier(CODE, null))).toBe(quiet);
  });

  it("changes to a different code, and takes a pending refusal with it either way", () => {
    const other = scanReducer(rejecting(), carrier(OTHER, REJECTION));
    expect(other.carrierError?.raw).toBe(OTHER);

    // FR-3: a code in the frame ends a refusal, including its pending half — and that has to
    // happen even when the rejection itself has not changed, or the identity return above
    // would swallow the clear.
    const pending = run([carrier(CODE, REJECTION), refused(PART, EPOCH)], streaming());
    expect(pending.refusalSeen?.refusal.raw).toBe(PART);
    const again = scanReducer(pending, carrier(CODE, REJECTION));
    expect(again.refusalSeen).toBeNull();
    expect(again.carrierError?.raw).toBe(CODE);
  });

  it("is left standing by an agreed refusal, because that precedence is the screen's (FR-4)", () => {
    // FR-4 answers a refusal replacing a carrier by deriving the banner from `refusal ===
    // null`, and that decision is untouched here: the machine keeps both facts, and which of
    // the two banners is on screen stays the screen's to derive. Clearing it here would make
    // "Keep scanning" on the refusal put this notice back — the resurrection FR-4's own test
    // pins shut.
    const machine = run([refused(PART, EPOCH), refused(PART, EPOCH + 200)], rejecting());
    expect(machine.refusal?.raw).toBe(PART);
    expect(machine.carrierError?.raw).toBe(CODE);
  });
});
