/**
 * [FR-2] §6.3's two-read agreement, applied to a read that is not a VIN.
 *
 * The scan loop decodes several times a second and most misses are noise, so §6.4 rules
 * that garbage keeps the scanner going and says nothing. A coherent read is the other
 * case: the DYNACRAFT part number in the field report decoded cleanly, completely and
 * identically on every frame it was in shot for — it simply is not a VIN, and that is
 * worth saying.
 *
 * The line between the two is drawn with the rule §6.3 already has rather than a second
 * timing rule invented for this: **a second identical read inside `CONFIRM_WINDOW_MS`**. A
 * symbol in front of the camera decodes to the same bytes every frame; noise does not
 * repeat itself. One read says nothing, which is what keeps the banner from strobing, and
 * what is *shown* only ever changes on agreement, which is what keeps it from flickering
 * between two half-read symbols.
 *
 * None of this is a `ScanState` (§4.10 is a §4 constant, N6): the machine stays
 * `streaming` throughout, the camera is never stopped and nothing is ever written.
 */
import { describe, expect, it } from "vitest";

import {
  CONFIRM_WINDOW_MS,
  COOLDOWN_MS,
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
/** The report's part number, and a second field off the same sticker. */
const PART = "R25-1251-200622120";
const CHASSIS = "414556";
const EPOCH = Date.UTC(2026, 8, 5, 12, 0, 0);

/** §4.2's refusal for `raw`, so the machine is fed what the decoder really produces. */
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

const MOUNT: ScanAction = { type: "mount", secureContext: true };
const STARTED: ScanAction = { type: "stream_started" };

/**
 * One of the app's own §4.9 codes in the frame, in the two answers the screen can give it
 * (FR-6): `CARRIER` is a code this app cannot read, so §6.4 owes it a rejection, and `TAKEN`
 * is one the screen took and is navigating to Import with. Either way the frame has moved on,
 * which is all FR-3 is about.
 */
const CARRIER: ScanAction = {
  type: "carrier",
  raw: "https://vinrelay.example/#/i?d=eyJ2IjoyfQ",
  message: "This payload is version 2; this app reads version 1.",
};
const TAKEN: ScanAction = { ...CARRIER, message: null };

/** A machine with the camera running, which is the only state a frame arrives in. */
function streaming(): ScanMachine {
  return run([MOUNT, STARTED]);
}

describe("[FR-2] one read says nothing", () => {
  it("holds the first refusal without showing it", () => {
    const machine = scanReducer(streaming(), refused(PART, EPOCH));
    // Nothing on screen. Most single decodes on a scan screen are a symbol half in shot.
    expect(machine.refusal).toBeNull();
    // But it is remembered, or a second identical frame would have nothing to agree with.
    expect(machine.refusalSeen?.refusal.raw).toBe(PART);
    expect(machine.refusalSeen?.atMs).toBe(EPOCH);
  });

  it("says nothing when two frames disagree", () => {
    // Two different fields off the same sticker, one after the other: neither is confirmed,
    // because neither was read twice.
    const machine = run([refused(PART, EPOCH), refused(CHASSIS, EPOCH + 200)], streaming());
    expect(machine.refusal).toBeNull();
    expect(machine.refusalSeen?.refusal.raw).toBe(CHASSIS);
  });

  it("says nothing when the second read is too late", () => {
    const late = run(
      [refused(PART, EPOCH), refused(PART, EPOCH + CONFIRM_WINDOW_MS + 1)],
      streaming(),
    );
    expect(late.refusal).toBeNull();
    // The window rolls forward, so the next frame is measured against the later read.
    expect(late.refusalSeen?.atMs).toBe(EPOCH + CONFIRM_WINDOW_MS + 1);
  });
});

describe("[FR-2] two reads that agree are said", () => {
  it("shows the read once a second frame repeats it", () => {
    const machine = run([refused(PART, EPOCH), refused(PART, EPOCH + 620)], streaming());
    expect(machine.refusal?.raw).toBe(PART);
    // The evidence comes with it, which is what the screen quotes (§4.2 step 2).
    expect(machine.refusal?.reason).toBe("no_run_of_17");
    expect(machine.refusal?.longestRun).toBe("200622120");
  });

  it("uses §6.3's window and its bound, not a second timing rule", () => {
    // Inclusive, exactly as §6.3's other window is: a gap of the constant is inside it.
    const onTime = run(
      [refused(PART, EPOCH), refused(PART, EPOCH + CONFIRM_WINDOW_MS)],
      streaming(),
    );
    expect(onTime.refusal?.raw).toBe(PART);
    expect(CONFIRM_WINDOW_MS).toBe(1500);
  });

  it("is two-sided, so a clock correction cannot confirm anything", () => {
    // The stamps come from `Date.now()`, which follows the wall clock. A frame stamped
    // before the one it is measured against is not within any window of it — the same rule
    // §6.3's VIN agreement and its cooldown are read under.
    const back = run([refused(PART, EPOCH), refused(PART, EPOCH - 1)], streaming());
    expect(back.refusal).toBeNull();
  });

  it("keeps a shown read standing while a different one is only seen once", () => {
    const machine = run(
      [refused(PART, EPOCH), refused(PART, EPOCH + 200), refused(CHASSIS, EPOCH + 400)],
      streaming(),
    );
    // The banner does not flicker to a read nothing has agreed on yet.
    expect(machine.refusal?.raw).toBe(PART);
    expect(machine.refusalSeen?.refusal.raw).toBe(CHASSIS);

    // And it changes to the new one as soon as that one agrees with itself.
    const later = scanReducer(machine, refused(CHASSIS, EPOCH + 600));
    expect(later.refusal?.raw).toBe(CHASSIS);
  });
});

describe("[FR-2] a refusal changes nothing else about the scan", () => {
  it("never leaves `streaming`, never stops the camera and never writes (N1, §6.4)", () => {
    const machine = run([refused(PART, EPOCH), refused(PART, EPOCH + 100)], streaming());
    // §6.4: "Garbage / partial reads → NO_VIN, scanner keeps going." A coherent read that
    // is not a VIN keeps it going too — the message is the only difference.
    expect(machine.state).toEqual({ kind: "streaming" });
    // Nothing was persisted, so nothing may cool down: the cooldown is `accepted`'s alone.
    expect(machine.cooldown).toEqual({});
    expect(COOLDOWN_MS).toBe(10000);
  });

  it("is ignored from a stream that is not live", () => {
    // A late frame out of ZXing's already-queued timer describes a scene nobody is
    // pointing at, exactly as it cannot resurrect a candidate.
    const idle = scanReducer(initialScanMachine, refused(PART, EPOCH));
    expect(idle.refusal).toBeNull();
    expect(idle.refusalSeen).toBeNull();

    const hidden = run([refused(PART, EPOCH), { type: "hidden", atMs: EPOCH }], streaming());
    const afterHide = scanReducer(hidden, refused(PART, EPOCH + 200));
    expect(afterHide.refusal).toBeNull();
    expect(afterHide.refusalSeen?.atMs).toBe(EPOCH);

    const confirmed = run(
      [
        { type: "decoded", sighting: sighting(VIN, EPOCH) },
        { type: "decoded", sighting: sighting(VIN, EPOCH + 100) },
      ],
      streaming(),
    );
    expect(confirmed.state.kind).toBe("confirmed");
    expect(scanReducer(confirmed, refused(PART, EPOCH + 200)).refusal).toBeNull();
  });
});

describe("[FR-2] a refusal is about the code in the frame, and does not outlive it", () => {
  /** A machine with an agreed refusal on screen. */
  function showing(): ScanMachine {
    const machine = run([refused(PART, EPOCH), refused(PART, EPOCH + 200)], streaming());
    expect(machine.refusal?.raw).toBe(PART);
    return machine;
  }

  it("is dropped by a VIN in the frame", () => {
    // R3-F5's rule: a notice describing something that is no longer there is a guess shown
    // as a fact (N2). The screen has a read to show instead.
    const decoded = scanReducer(showing(), {
      type: "decoded",
      sighting: sighting(VIN, EPOCH + 300),
    });
    expect(decoded.state.kind).toBe("candidate");
    expect(decoded.refusal).toBeNull();
    expect(decoded.refusalSeen).toBeNull();
  });

  it("is dropped by one of the app's own §4.9 codes in the frame (FR-3)", () => {
    // A carrier is a code in the frame, so the refused code is not what the camera is
    // looking at any more — the same fact `decoded` reports above, and the reason FR-3 was
    // two banners at once: §6.4's "Couldn't read that code" beside a refusal about a code
    // that had left the frame, each offering "Keep scanning" (N2, P7).
    const carrier = scanReducer(showing(), CARRIER);
    expect(carrier.refusal).toBeNull();
    expect(carrier.refusalSeen).toBeNull();
    // §4.10 gains no state for a carrier, and the stream is never stopped for one (N1, N6).
    expect(carrier.state).toEqual({ kind: "streaming" });

    // The pending half goes too, or a frame from before the carrier would agree with one
    // from after it and raise a banner about the code that has just been replaced.
    const pending = run([refused(PART, EPOCH), CARRIER, refused(PART, EPOCH + 200)], streaming());
    expect(pending.refusal).toBeNull();

    // And nothing to clear is the same machine, not a copy of it: the code decodes several
    // times a second, and a fresh machine per frame would re-render the screen at the decode
    // rate for no change. Since FR-6 the rejection is the machine's too, so "nothing to clear"
    // means nothing to *say* either — `scanMachine.carrier.test.ts` holds the other half of
    // this property, where the same rejection is already standing.
    const quiet = streaming();
    expect(scanReducer(quiet, TAKEN)).toBe(quiet);

    // A late frame out of ZXing's already-queued timer describes a scene nobody is pointing
    // at, so it cannot take down an answer that is still true (the same guard `refused` and
    // `decoded` are read under; a short hide keeps the refusal, below).
    const hidden = scanReducer(showing(), { type: "hidden", atMs: EPOCH + 300 });
    expect(scanReducer(hidden, CARRIER).refusal?.raw).toBe(PART);
  });

  it("is dropped by every restart of the camera", () => {
    for (const action of [MOUNT, { type: "retry", secureContext: true } as ScanAction]) {
      const after = scanReducer(showing(), action);
      expect(after.refusal, action.type).toBeNull();
      expect(after.refusalSeen, action.type).toBeNull();
    }

    // The re-request `visible` makes after a long hide is a restart like any other.
    const back = run(
      [
        { type: "hidden", atMs: EPOCH + 300 },
        { type: "visible", atMs: EPOCH + 300 + HIDDEN_LOST_MS + 1, secureContext: true },
      ],
      showing(),
    );
    expect(back.state).toEqual({ kind: "requesting" });
    expect(back.refusal).toBeNull();
  });

  it("is already gone by the time a read can be rescanned or saved", () => {
    // Why neither `rescan` nor `accepted` clears anything: both act on a `confirmed`
    // machine, and the only way into `confirmed` is the decode that dropped the refusal
    // above. A second clear would be a line no test could tell from its own absence.
    const held = run(
      [
        { type: "decoded", sighting: sighting(VIN, EPOCH + 300) },
        { type: "decoded", sighting: sighting(VIN, EPOCH + 400) },
      ],
      showing(),
    );
    expect(held.state.kind).toBe("confirmed");
    expect(held.refusal).toBeNull();

    const rescanned = scanReducer(held, { type: "rescan" });
    expect(rescanned.state).toEqual({ kind: "streaming" });
    expect(rescanned.refusal).toBeNull();

    const saved = scanReducer(held, { type: "accepted", vin: VIN, atMs: EPOCH + 500 });
    expect(saved.refusal).toBeNull();
    expect(saved.cooldown[VIN]).toBe(EPOCH + 500);
  });

  it("survives a short hide, which is the same scene coming back", () => {
    // §6.3 drops a *candidate* on hide because confirming it on return would be a scan the
    // user never took. Nothing is written here, so there is nothing to take: the sticker
    // is still under the camera and the answer to it is still true.
    const back = run(
      [
        { type: "hidden", atMs: EPOCH + 300 },
        { type: "visible", atMs: EPOCH + 400, secureContext: true },
      ],
      showing(),
    );
    expect(back.state).toEqual({ kind: "streaming" });
    expect(back.refusal?.raw).toBe(PART);
  });
});
