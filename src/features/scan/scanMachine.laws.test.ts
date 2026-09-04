/**
 * Round-2 additions to the §6.3 machine's suite: the laws nothing states yet, the branches
 * the existing tests execute without asserting on, and the ends of the three windows that no
 * test pins.
 *
 * What is deliberately NOT repeated, because it is already proved:
 *  - unknown states, and "only `accepted` writes the cooldown map" — `scanMachine.test.ts`;
 *  - "a confirmation carries the candidate's VIN" — both existing files;
 *  - "a VIN inside its cooldown window never confirms, whatever preceded it", purity, and the
 *    `hiddenAtMs` lifecycle — `scanMachine.props.test.ts`;
 *  - the outer edges 1499/1500/1501, 9999/10000/10001, 29999/30000/30001 and the constants
 *    themselves — pinned in both files. This one adds the ends they leave open: a gap of
 *    zero, and a gap of minus one.
 *
 * The generator is its own model rather than a copy of the one next door, because two of the
 * laws below need the *same* session materialised twice — once with the raw bytes, check
 * digit and symbology a decoder would vary, once with them held constant.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  COOLDOWN_MS,
  CONFIRM_WINDOW_MS,
  HIDDEN_LOST_MS,
  initialScanMachine,
  scanReducer,
} from "./scanMachine";
import type { ScanAction, ScanMachine, ScanSighting } from "./scanMachine";
import type { ScanError, Symbology } from "../../lib/vin/types";

/** §4.11 fixtures. The machine compares VINs, it never parses them. */
const VIN_A = "1HGCM82633A004352";
const VIN_B = "1HGCM826X3A004350";
const VINS = [VIN_A, VIN_B] as const;

/** §4.10, the four a camera can report and the four a stream can fail with. */
const SYMBOLOGIES = ["code_39", "code_128", "data_matrix", "qr_code"] as const;
const ERRORS = ["permission_denied", "no_camera", "insecure_context", "stream_lost"] as const;

/** A wall clock, where an absolute stamp and an elapsed gap are six orders of magnitude apart. */
const EPOCH = Date.UTC(2026, 8, 4, 12, 0, 0);

const MOUNT: ScanAction = { type: "mount", secureContext: true };
const STARTED: ScanAction = { type: "stream_started" };

function sighting(vin: string, atMs: number, over: Partial<ScanSighting> = {}): ScanSighting {
  return { vin, raw: vin, checkDigitValid: true, symbology: "code_39", atMs, ...over };
}

function saw(vin: string, atMs: number, over: Partial<ScanSighting> = {}): ScanAction {
  return { type: "decoded", sighting: sighting(vin, atMs, over) };
}

function run(actions: ScanAction[], from: ScanMachine = initialScanMachine): ScanMachine {
  return actions.reduce(scanReducer, from);
}

function streaming(): ScanMachine {
  return run([MOUNT, STARTED]);
}

function confirmed(): ScanMachine {
  return run([saw(VIN_A, EPOCH), saw(VIN_A, EPOCH + 200)], streaming());
}

// ---------------------------------------------------------------------------
// The ends of the windows no test reaches
// ---------------------------------------------------------------------------

describe("§6.3 windows — the ends the outer boundaries leave open", () => {
  it("confirms two readings stamped in the same millisecond", () => {
    // `Date.now()` is not a high-resolution clock: Firefox clamps it to 100 ms and Safari to
    // 1 ms as a fingerprinting defence, and ZXing is asked for an attempt every 100 ms. Two
    // agreeing frames therefore can and do arrive under one stamp, and §6.3 asks only for "a
    // second identical normalized VIN within 1.5 s" — nought is within 1.5 s. A window that
    // demanded a strictly positive gap would never confirm on such a device.
    const machine = run([saw(VIN_A, EPOCH), saw(VIN_A, EPOCH)], streaming());
    expect(machine.state).toEqual({ kind: "confirmed", sighting: sighting(VIN_A, EPOCH) });
  });

  it("does not confirm on a reading stamped one millisecond before the candidate", () => {
    // The tight end of the two-sided window (round-1 A-17). The existing tests jump an hour
    // and a minute backwards; a fault that clamped the lower bound at, say, minus one second
    // would pass all of them. A reading that predates the candidate is a fresh first reading.
    const machine = run([saw(VIN_A, EPOCH), saw(VIN_A, EPOCH - 1)], streaming());
    expect(machine.state).toEqual({ kind: "candidate", sighting: sighting(VIN_A, EPOCH - 1) });
  });

  it("does not cool down a reading stamped one millisecond before the acceptance", () => {
    // Same tight end, on the 10 s window. §6.3 ignores a VIN "confirmed again within 10 s";
    // a reading from before the acceptance is not within any forward window of it, and the
    // scanner must not go quiet because the system clock stepped back a millisecond.
    const accepted = run([{ type: "accepted", vin: VIN_A, atMs: EPOCH }, MOUNT, STARTED]);
    expect(accepted.state).toEqual({ kind: "streaming" });
    expect(scanReducer(accepted, saw(VIN_A, EPOCH))).toBe(accepted);
    expect(scanReducer(accepted, saw(VIN_A, EPOCH - 1)).state).toEqual({
      kind: "candidate",
      sighting: sighting(VIN_A, EPOCH - 1),
    });
  });

  it("resumes a stream that was hidden for no time at all", () => {
    const machine = run(
      [
        { type: "hidden", atMs: EPOCH },
        { type: "visible", atMs: EPOCH, secureContext: true },
      ],
      streaming(),
    );
    expect(machine.state).toEqual({ kind: "streaming" });
  });

  it("treats a clock that stepped back during a hide as a short absence, not a lost stream", () => {
    // The 30 s test is one-sided on purpose, and the direction matters: a negative gap means
    // the clock moved, not that the tab was away for minus a minute. Re-requesting the camera
    // here would be harmless; reading it as "lost" and stopping would not be, so the choice
    // is stated rather than left to whoever next edits the comparison.
    const machine = run(
      [
        { type: "hidden", atMs: EPOCH + 60_000 },
        { type: "visible", atMs: EPOCH, secureContext: true },
      ],
      streaming(),
    );
    expect(machine.state).toEqual({ kind: "streaming" });
    expect(machine.hiddenAtMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Branches the suite executes with no assertion about their effect
// ---------------------------------------------------------------------------

describe("§6.3 branches the suite runs through without asserting on", () => {
  it("ignores a stream failure that arrives while the tab is hidden", () => {
    // Hiding releases the camera (`useScanner`'s effect cleanup), and a released camera
    // reports its own teardown. §6.3 keeps `stream_lost` for a stream that died under the
    // user, so a failure the app caused itself must not paint an error the user comes back
    // to — the machine is still `streaming` and resumes when the tab does.
    const hidden = run([{ type: "hidden", atMs: EPOCH }], streaming());
    expect(hidden.state).toEqual({ kind: "streaming" });
    for (const error of ERRORS) {
      expect(scanReducer(hidden, { type: "stream_failed", error })).toBe(hidden);
    }
    const back = scanReducer(hidden, { type: "visible", atMs: EPOCH + 500, secureContext: true });
    expect(back.state).toEqual({ kind: "streaming" });
  });

  it("ignores a track that ends while the tab is hidden", () => {
    // The same teardown, reported through the track's own `ended` event. Left honoured, every
    // pocketed phone would come back to "Camera stopped." having lost nothing at all.
    const hidden = run([{ type: "hidden", atMs: EPOCH }], streaming());
    expect(scanReducer(hidden, { type: "track_ended" })).toBe(hidden);
    const candidateHidden = run(
      [saw(VIN_A, EPOCH), { type: "hidden", atMs: EPOCH + 1 }],
      streaming(),
    );
    expect(scanReducer(candidateHidden, { type: "track_ended" })).toBe(candidateHidden);
  });

  it("still reports a permission prompt that fails while the tab is hidden", () => {
    // The other half of the same guard, and it must not be quiet: the prompt is what put the
    // tab in the background, so a denial arrives with the page hidden almost every time. §6.4
    // owes that user the blocked-camera line and a Retry, not a preview that never starts.
    const hidden = run([{ type: "hidden", atMs: EPOCH }], run([MOUNT]));
    expect(hidden.state).toEqual({ kind: "requesting" });
    const machine = scanReducer(hidden, { type: "stream_failed", error: "permission_denied" });
    expect(machine.state).toEqual({ kind: "error", error: "permission_denied" });
    // Coming back does not clear it: §6.3 leaves an error standing for the user to act on.
    const back = scanReducer(machine, { type: "visible", atMs: EPOCH + 800, secureContext: true });
    expect(back.state).toEqual({ kind: "error", error: "permission_denied" });
  });

  it("drops a held read on a remount without recording a cooldown for it", () => {
    // `useScanner` dispatches `mount` whenever the scanner is re-enabled — which is what
    // closing the manual-entry sheet does with a mismatch banner still up. The pending
    // Rescan / Use as-is decision is abandoned, and because nothing was written, §6.3 forbids
    // a cooldown entry: the same label must read again on the next frame, not in ten seconds.
    for (const action of [MOUNT, { type: "retry", secureContext: true } as const]) {
      const machine = scanReducer(confirmed(), action);
      expect(machine.state).toEqual({ kind: "requesting" });
      expect(machine.cooldown).toEqual({});
      const again = run([STARTED, saw(VIN_A, EPOCH + 300), saw(VIN_A, EPOCH + 400)], machine);
      expect(again.state.kind).toBe("confirmed");
    }
  });
});

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * One thing that happens to a scanner. `dt` is the delay since the last thing (a clock that
 * only moves forward, like a device); `at` is an absolute stamp drawn independently, which
 * models a clock that has been corrected under the app. Every plan is run in one mode or the
 * other, so an ordering assumption shows up in one and a wall-clock assumption in both.
 */
type Step =
  | { k: "decode"; vin: 0 | 1; dt: number; at: number; noise: Noise }
  | { k: "accept"; vin: 0 | 1; dt: number; at: number }
  | { k: "hidden"; dt: number; at: number }
  | { k: "visible"; dt: number; at: number }
  | { k: "failed"; error: ScanError }
  | { k: "rescan" }
  | { k: "ended" }
  | { k: "remount" };

/** Everything about a sighting that §6.3 does not decide on. */
interface Noise {
  raw: string;
  checkDigitValid: boolean;
  symbology: Symbology;
}

const noiseArb: fc.Arbitrary<Noise> = fc.record({
  raw: fc.string(),
  checkDigitValid: fc.boolean(),
  symbology: fc.constantFrom(...SYMBOLOGIES),
});

const timed = <T extends string>(k: T, dt: fc.Arbitrary<number>) => ({
  k: fc.constant(k),
  dt,
  at: fc.integer({ min: EPOCH, max: EPOCH + 120_000 }),
});

/**
 * Frame-to-frame delay. ZXing is asked for an attempt every 100 ms, so most gaps between two
 * readings are well inside the 1.5 s agreement window and a minority fall outside it. A
 * generator drawn flat across 0–2.5 s spends half its readings failing to agree and rarely
 * gets anywhere (A-29).
 */
const decodeGapArb = fc.oneof(
  { arbitrary: fc.integer({ min: 0, max: 400 }), weight: 6 },
  { arbitrary: fc.integer({ min: 0, max: 2_500 }), weight: 1 },
);

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  // Weighted like a stream: mostly readings, close together, so sequences actually reach the
  // states where the two-read rule and the cooldown decide something.
  {
    arbitrary: fc.record({
      ...timed("decode" as const, decodeGapArb),
      vin: fc.nat(1),
      noise: noiseArb,
    }),
    weight: 8,
  },
  {
    arbitrary: fc.record({
      ...timed("accept" as const, fc.integer({ min: 0, max: 500 })),
      vin: fc.nat(1),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record(timed("hidden" as const, fc.integer({ min: 0, max: 40_000 }))),
    weight: 1,
  },
  {
    arbitrary: fc.record(timed("visible" as const, fc.integer({ min: 0, max: 40_000 }))),
    weight: 1,
  },
  {
    arbitrary: fc.record({ k: fc.constant("failed" as const), error: fc.constantFrom(...ERRORS) }),
    weight: 1,
  },
  { arbitrary: fc.constant<Step>({ k: "rescan" }), weight: 1 },
  { arbitrary: fc.constant<Step>({ k: "ended" }), weight: 1 },
  { arbitrary: fc.constant<Step>({ k: "remount" }), weight: 2 },
) as fc.Arbitrary<Step>;

interface Plan {
  steps: readonly Step[];
  /** Draw each timestamp independently instead of advancing a clock. */
  jitter: boolean;
}

const planArb: fc.Arbitrary<Plan> = fc.record({
  steps: fc.array(stepArb, { minLength: 25, maxLength: 70, size: "max" }),
  jitter: fc.boolean(),
});

/** A fixed sighting body, for the run that has to differ from the noisy one only in noise. */
const PLAIN: Noise = { raw: "", checkDigitValid: true, symbology: "code_39" };

function toActions(plan: Plan, opts: { plain?: boolean } = {}): ScanAction[] {
  let clock = EPOCH;
  const out: ScanAction[] = [MOUNT, STARTED];
  for (const step of plan.steps) {
    let at = 0;
    if ("dt" in step) {
      clock += step.dt;
      at = plan.jitter ? step.at : clock;
    }
    switch (step.k) {
      case "decode": {
        const { raw, checkDigitValid, symbology } = opts.plain === true ? PLAIN : step.noise;
        out.push({
          type: "decoded",
          sighting: { vin: VINS[step.vin], raw, checkDigitValid, symbology, atMs: at },
        });
        break;
      }
      case "accept":
        out.push({ type: "accepted", vin: VINS[step.vin], atMs: at });
        break;
      case "hidden":
        out.push({ type: "hidden", atMs: at });
        break;
      case "visible":
        out.push({ type: "visible", atMs: at, secureContext: true });
        break;
      case "failed":
        out.push({ type: "stream_failed", error: step.error });
        break;
      case "rescan":
        out.push({ type: "rescan" });
        break;
      case "ended":
        out.push({ type: "track_ended" });
        break;
      case "remount":
        // `useScanner` dispatches both when the scanner is re-enabled.
        out.push(MOUNT, STARTED);
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The generator itself, measured
// ---------------------------------------------------------------------------

interface Reach {
  plans: number;
  confirmations: number;
  cooled: number;
  hidUnderCandidate: number;
}

/** What a sample of plans actually reaches, counted rather than assumed. */
function reach(plans: readonly Plan[]): Reach {
  const out: Reach = { plans: plans.length, confirmations: 0, cooled: 0, hidUnderCandidate: 0 };
  for (const plan of plans) {
    let machine = initialScanMachine;
    for (const action of toActions(plan)) {
      const before = machine;
      machine = scanReducer(before, action);
      if (machine.state.kind === "confirmed" && before.state.kind !== "confirmed") {
        out.confirmations += 1;
      }
      if (action.type === "hidden" && before.state.kind === "candidate") {
        out.hidUnderCandidate += 1;
      }
      if (
        action.type === "decoded" &&
        machine === before &&
        before.hiddenAtMs === null &&
        before.cooldown[action.sighting.vin] !== undefined &&
        (before.state.kind === "streaming" || before.state.kind === "candidate")
      ) {
        out.cooled += 1;
      }
    }
  }
  return out;
}

describe("the generator reaches the states these laws are about", () => {
  // A-29: a suite of laws proves nothing if its sequences never arrive anywhere, and a
  // percentage cannot tell you they did. These counts are the generator's own gate — a later
  // edit that quietly stops producing confirmations fails here instead of going green.
  const sample = (jitter: boolean, seed: number) =>
    reach(
      fc
        .sample(fc.array(stepArb, { minLength: 25, maxLength: 70, size: "max" }), {
          numRuns: 200,
          seed,
        })
        .map((steps) => ({ steps, jitter })),
    );

  it("confirms, cools down and pockets the phone on a clock that moves forward", () => {
    // Measured on this seed: 165 confirmations, 324 readings dropped by the cooldown and 53
    // hides under a standing candidate, over 200 sessions. The floors sit at about half of
    // each, so the test states "the generator still gets there" rather than a fixed count.
    const got = sample(false, 0x5c9_2001);
    expect(got.confirmations).toBeGreaterThan(80);
    expect(got.cooled).toBeGreaterThan(150);
    expect(got.hidUnderCandidate).toBeGreaterThan(25);
  });

  it("exercises the same states when the timestamps are drawn out of order", () => {
    // The second model is for the ordering assumptions, not for throughput: independently
    // drawn stamps rarely put two agreeing readings 1.5 s apart, so confirmations are scarce
    // by construction (7 on this seed). What it does reach in quantity is the paths that
    // decide *whether* to honour a reading — a cooldown compared against a stamp from either
    // side of it, and a hide arriving under a candidate.
    const got = sample(true, 0x5c9_2001);
    expect(got.confirmations).toBeGreaterThan(2);
    expect(got.cooled).toBeGreaterThan(25);
    expect(got.hidUnderCandidate).toBeGreaterThan(40);
  });
});

// ---------------------------------------------------------------------------
// Laws
// ---------------------------------------------------------------------------

describe("§6.3 laws nothing states yet", () => {
  it("never rebuilds a sighting: what is confirmed is the object the decoder handed in", () => {
    // §5.2 stores `raw` and `checkDigitValid` from the confirmed sighting, and §6.3's mismatch
    // branch reads the same flag to decide whether anything may be written at all. A reducer
    // that copied a sighting — or carried the first read's `raw` into the confirmation —
    // would still satisfy every VIN-and-timestamp law in this directory, and would write a
    // record describing bytes nobody read (N2). Reference identity is the only test that
    // catches it.
    fc.assert(
      fc.property(planArb, (plan) => {
        let machine = initialScanMachine;
        for (const action of toActions(plan)) {
          const before = machine;
          machine = scanReducer(before, action);
          const after = machine.state;
          const held = after.kind === "candidate" || after.kind === "confirmed";
          if (action.type === "decoded") {
            if (machine === before) continue;
            expect(held).toBe(true);
            if (!held) return;
            expect(after.sighting).toBe(action.sighting);
          } else if (held) {
            const prior = before.state;
            expect(prior.kind === "candidate" || prior.kind === "confirmed").toBe(true);
            if (prior.kind !== "candidate" && prior.kind !== "confirmed") return;
            expect(after.sighting).toBe(prior.sighting);
          }
        }
      }),
      { seed: 0x5c9_2002, numRuns: 400 },
    );
  });

  it("decides on the VIN and the clock alone, never on the check digit or the symbology", () => {
    // §6.3's two-read rule is "a second identical normalized VIN within 1.5 s" — the check
    // digit is not part of it, and must not become part of it: the confirmed-with-mismatch
    // state is what raises the Rescan / Use as-is banner, so a machine that refused to confirm
    // a failed check digit would silently delete that whole branch of the spec, and a scanner
    // that would not confirm a §4.3 identifier carrying no check digit at all (D17) would
    // refuse to read a legitimate off-highway PIN. Symbology and raw bytes are likewise not
    // the machine's business — the same label read once as CODE_39 and once as CODE_128 is
    // the same read agreeing with itself.
    fc.assert(
      fc.property(planArb, (plan) => {
        const noisy = toActions(plan);
        const plain = toActions(plan, { plain: true });
        expect(plain).toHaveLength(noisy.length);
        let a = initialScanMachine;
        let b = initialScanMachine;
        for (let i = 0; i < noisy.length; i += 1) {
          a = scanReducer(a, noisy[i]!);
          b = scanReducer(b, plain[i]!);
          expect(b.state.kind).toBe(a.state.kind);
          expect(b.cooldown).toEqual(a.cooldown);
          expect(b.hiddenAtMs).toBe(a.hiddenAtMs);
          if (a.state.kind === "candidate" || a.state.kind === "confirmed") {
            const other = b.state;
            expect(other.kind === "candidate" || other.kind === "confirmed").toBe(true);
            if (other.kind !== "candidate" && other.kind !== "confirmed") return;
            expect(other.sighting.vin).toBe(a.state.sighting.vin);
            expect(other.sighting.atMs).toBe(a.state.sighting.atMs);
          }
        }
      }),
      { seed: 0x5c9_2003, numRuns: 400 },
    );
  });

  it("never pairs two readings across a hidden tab", () => {
    // The pocket scan: a phone put away between two frames of the same label must not come
    // back holding a confirmed read. The adversary file pins one such sequence; this is the
    // law — whatever the sequence, the reading that established the standing candidate is
    // always later than the last `hidden`.
    fc.assert(
      fc.property(planArb, (plan) => {
        let machine = initialScanMachine;
        let candidateAt = -1;
        let hiddenAt = -1;
        const acts = toActions(plan);
        for (let i = 0; i < acts.length; i += 1) {
          const action = acts[i]!;
          const before = machine;
          machine = scanReducer(before, action);
          if (action.type === "hidden") hiddenAt = i;
          const after = machine.state;
          if (after.kind === "candidate") {
            const prior = before.state;
            const same = prior.kind === "candidate" && prior.sighting === after.sighting;
            if (!same) candidateAt = i;
          }
          if (after.kind === "confirmed" && before.state.kind !== "confirmed") {
            expect(candidateAt).toBeGreaterThan(hiddenAt);
          }
        }
      }),
      { seed: 0x5c9_2004, numRuns: 400 },
    );
  });

  it("never holds a candidate while the tab is recorded as hidden", () => {
    // The structural half of the same rule, and the invariant `isLive` depends on: a candidate
    // and a recorded hide cannot coexist, because `hidden` drops the pending read and no
    // decode is honoured until the tab is back. If they ever did coexist, the next reading
    // would confirm against a candidate taken before the phone went into a pocket.
    fc.assert(
      fc.property(planArb, (plan) => {
        let machine = initialScanMachine;
        for (const action of toActions(plan)) {
          machine = scanReducer(machine, action);
          if (machine.state.kind === "candidate") expect(machine.hiddenAtMs).toBeNull();
        }
      }),
      { seed: 0x5c9_2005, numRuns: 400 },
    );
  });
});

// ---------------------------------------------------------------------------
// The constants are used where §6.3 says, not merely present
// ---------------------------------------------------------------------------

describe("§6.3 constants are wired to the rule they belong to", () => {
  it("uses 1.5 s for agreement, 10 s for the cooldown and 30 s for a lost stream", () => {
    // The values themselves are pinned next door. This pins that they are not interchangeable:
    // each check is exercised at a gap the other two constants would answer differently.
    const between = (a: number, b: number) => Math.floor((a + b) / 2);
    const mid = between(CONFIRM_WINDOW_MS, COOLDOWN_MS); // 5750: outside 1.5 s, inside 10 s
    const far = between(COOLDOWN_MS, HIDDEN_LOST_MS); // 20000: outside 10 s, inside 30 s

    expect(run([saw(VIN_A, EPOCH), saw(VIN_A, EPOCH + mid)], streaming()).state.kind).toBe(
      "candidate",
    );

    const accepted = run([{ type: "accepted", vin: VIN_A, atMs: EPOCH }, MOUNT, STARTED]);
    expect(scanReducer(accepted, saw(VIN_A, EPOCH + mid))).toBe(accepted);
    expect(scanReducer(accepted, saw(VIN_A, EPOCH + far)).state.kind).toBe("candidate");

    const hidden = run([{ type: "hidden", atMs: EPOCH }], streaming());
    expect(
      scanReducer(hidden, { type: "visible", atMs: EPOCH + far, secureContext: true }).state,
    ).toEqual({ kind: "streaming" });
  });
});
