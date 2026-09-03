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

const VIN_A = "1HGCM82633A004352";
const VIN_B = "1HGCM826X3A004350";

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

/** Every state before a decode: mounted, permitted, decoding. */
function streaming(): ScanMachine {
  return run([MOUNT, STARTED]);
}

/** A confirmed read of VIN_A at 1000 ms, two-read agreement satisfied. */
function confirmed(): ScanMachine {
  return run([saw(VIN_A, 0), saw(VIN_A, 1000)], streaming());
}

describe("scanReducer — startup", () => {
  it("starts idle and not lost", () => {
    expect(initialScanMachine).toEqual({
      state: { kind: "idle", lost: false },
      cooldown: {},
      hiddenAtMs: null,
    });
  });

  it("goes idle → requesting on mount", () => {
    expect(scanReducer(initialScanMachine, MOUNT).state).toEqual({ kind: "requesting" });
  });

  it("errors on an insecure context without ever requesting permission", () => {
    const machine = scanReducer(initialScanMachine, { type: "mount", secureContext: false });
    expect(machine.state).toEqual({ kind: "error", error: "insecure_context" });
  });

  it("goes requesting → streaming when the stream starts", () => {
    expect(streaming().state).toEqual({ kind: "streaming" });
  });

  it("ignores a stream start that no request is waiting on", () => {
    const machine = streaming();
    expect(scanReducer(machine, STARTED)).toBe(machine);
  });

  it("errors when permission is denied", () => {
    const machine = run([MOUNT, { type: "stream_failed", error: "permission_denied" }]);
    expect(machine.state).toEqual({ kind: "error", error: "permission_denied" });
  });

  it("errors when there is no camera", () => {
    const machine = run([MOUNT, { type: "stream_failed", error: "no_camera" }]);
    expect(machine.state).toEqual({ kind: "error", error: "no_camera" });
  });

  it("errors when a restart fails while streaming", () => {
    const machine = scanReducer(streaming(), { type: "stream_failed", error: "no_camera" });
    expect(machine.state).toEqual({ kind: "error", error: "no_camera" });
  });

  it("ignores a stream failure once the caller stopped the stream itself", () => {
    const machine = confirmed();
    expect(scanReducer(machine, { type: "stream_failed", error: "stream_lost" })).toBe(machine);
  });

  it("ignores a stream failure while idle", () => {
    expect(scanReducer(initialScanMachine, { type: "stream_failed", error: "stream_lost" })).toBe(
      initialScanMachine,
    );
  });
});

describe("scanReducer — retry", () => {
  it("re-requests from an error", () => {
    const denied = run([MOUNT, { type: "stream_failed", error: "permission_denied" }]);
    expect(scanReducer(denied, { type: "retry", secureContext: true }).state).toEqual({
      kind: "requesting",
    });
  });

  it("stays an error when the context is still insecure", () => {
    const insecure = scanReducer(initialScanMachine, { type: "mount", secureContext: false });
    expect(scanReducer(insecure, { type: "retry", secureContext: false }).state).toEqual({
      kind: "error",
      error: "insecure_context",
    });
  });

  it("clears a recorded hidden time", () => {
    const machine = run([MOUNT, STARTED, { type: "hidden", atMs: 500 }]);
    expect(scanReducer(machine, { type: "retry", secureContext: true }).hiddenAtMs).toBeNull();
  });

  it("keeps the cooldown across a remount, which is what the cooldown guards", () => {
    const machine = run([{ type: "accepted", vin: VIN_A, atMs: 5000 }, MOUNT]);
    expect(machine.cooldown).toEqual({ [VIN_A]: 5000 });
  });
});

describe("scanReducer — two-read agreement", () => {
  it("goes streaming → candidate on the first VIN seen", () => {
    const machine = scanReducer(streaming(), saw(VIN_A, 0));
    expect(machine.state).toEqual({ kind: "candidate", sighting: sighting(VIN_A, 0) });
  });

  it("stays a candidate on a single sighting", () => {
    expect(run([saw(VIN_A, 0)], streaming()).state.kind).toBe("candidate");
  });

  it("confirms a second identical VIN 1499 ms later", () => {
    const machine = run([saw(VIN_A, 0), saw(VIN_A, 1499)], streaming());
    expect(machine.state).toEqual({ kind: "confirmed", sighting: sighting(VIN_A, 1499) });
  });

  it("confirms exactly on the window boundary", () => {
    const machine = run([saw(VIN_A, 0), saw(VIN_A, CONFIRM_WINDOW_MS)], streaming());
    expect(machine.state.kind).toBe("confirmed");
  });

  it("does not confirm a second identical VIN 1501 ms later", () => {
    const machine = run([saw(VIN_A, 0), saw(VIN_A, 1501)], streaming());
    // A late repeat is a fresh first sighting; the window restarts on it.
    expect(machine.state).toEqual({ kind: "candidate", sighting: sighting(VIN_A, 1501) });
    expect(scanReducer(machine, saw(VIN_A, 2000)).state.kind).toBe("confirmed");
  });

  it("replaces the candidate when a different VIN is seen", () => {
    const machine = run([saw(VIN_A, 0), saw(VIN_B, 100)], streaming());
    expect(machine.state).toEqual({ kind: "candidate", sighting: sighting(VIN_B, 100) });
  });

  it("keeps the confirming sighting, not the first one", () => {
    const machine = run(
      [saw(VIN_A, 0, { raw: `*${VIN_A}*` }), saw(VIN_A, 200, { symbology: "data_matrix" })],
      streaming(),
    );
    expect(machine.state).toEqual({
      kind: "confirmed",
      sighting: sighting(VIN_A, 200, { symbology: "data_matrix" }),
    });
  });

  it("carries a failed check digit through to the confirmed read", () => {
    const bad = { checkDigitValid: false };
    const machine = run([saw(VIN_A, 0, bad), saw(VIN_A, 300, bad)], streaming());
    expect(machine.state).toEqual({
      kind: "confirmed",
      sighting: sighting(VIN_A, 300, bad),
    });
  });

  it("stays confirmed until accepted or rescanned", () => {
    const machine = confirmed();
    expect(scanReducer(machine, { type: "track_ended" })).toBe(machine);
    expect(scanReducer(machine, STARTED)).toBe(machine);
  });
});

describe("scanReducer — decodes that must be ignored", () => {
  it.each([
    ["idle", initialScanMachine],
    ["requesting", run([MOUNT])],
    ["confirmed", confirmed()],
    ["error", run([MOUNT, { type: "stream_failed", error: "permission_denied" }])],
  ])("ignores a decode while %s", (_kind, machine) => {
    expect(scanReducer(machine, saw(VIN_A, 9))).toBe(machine);
  });
});

describe("scanReducer — cooldown", () => {
  const accepted = run([{ type: "accepted", vin: VIN_A, atMs: 1000 }, MOUNT, STARTED], confirmed());

  it("returns to idle and records the acceptance", () => {
    const machine = scanReducer(confirmed(), { type: "accepted", vin: VIN_A, atMs: 1000 });
    expect(machine.state).toEqual({ kind: "idle", lost: false });
    expect(machine.cooldown).toEqual({ [VIN_A]: 1000 });
  });

  it("ignores the same VIN 9999 ms after it was accepted", () => {
    expect(scanReducer(accepted, saw(VIN_A, 1000 + 9999))).toBe(accepted);
  });

  it("ignores the same VIN exactly on the cooldown boundary", () => {
    expect(scanReducer(accepted, saw(VIN_A, 1000 + COOLDOWN_MS))).toBe(accepted);
  });

  it("reads the same VIN again 10001 ms after it was accepted", () => {
    const machine = run([saw(VIN_A, 1000 + 10001), saw(VIN_A, 1000 + 10500)], accepted);
    expect(machine.state.kind).toBe("confirmed");
  });

  it("never cools down a VIN that was not accepted", () => {
    const machine = scanReducer(accepted, saw(VIN_B, 1001));
    expect(machine.state).toEqual({ kind: "candidate", sighting: sighting(VIN_B, 1001) });
  });

  it("does not cool down a read the user rejected with Rescan", () => {
    const rescanned = scanReducer(confirmed(), { type: "rescan" });
    expect(rescanned.state).toEqual({ kind: "streaming" });
    expect(rescanned.cooldown).toEqual({});
    // The rejected VIN must be readable again immediately, not in ten seconds.
    const machine = run([saw(VIN_A, 1001), saw(VIN_A, 1002)], rescanned);
    expect(machine.state).toEqual({ kind: "confirmed", sighting: sighting(VIN_A, 1002) });
  });

  it("ignores a rescan outside the confirmed state", () => {
    const machine = streaming();
    expect(scanReducer(machine, { type: "rescan" })).toBe(machine);
  });
});

describe("scanReducer — stream loss and visibility", () => {
  it("returns to idle and reports the loss when the track ends while streaming", () => {
    expect(scanReducer(streaming(), { type: "track_ended" }).state).toEqual({
      kind: "idle",
      lost: true,
    });
  });

  it("returns to idle when the track ends under a candidate", () => {
    const machine = run([saw(VIN_A, 0), { type: "track_ended" }], streaming());
    expect(machine.state).toEqual({ kind: "idle", lost: true });
  });

  it("ignores a track ending that the caller caused", () => {
    const machine = run([MOUNT]);
    expect(scanReducer(machine, { type: "track_ended" })).toBe(machine);
  });

  it("drops a pending candidate when the tab is hidden", () => {
    const machine = run([saw(VIN_A, 0), { type: "hidden", atMs: 100 }], streaming());
    expect(machine.state).toEqual({ kind: "streaming" });
    expect(machine.hiddenAtMs).toBe(100);
  });

  it("records the hidden time without disturbing a state that has no candidate", () => {
    const machine = scanReducer(confirmed(), { type: "hidden", atMs: 100 });
    expect(machine.state.kind).toBe("confirmed");
    expect(machine.hiddenAtMs).toBe(100);
  });

  it("resumes streaming after 29999 ms hidden", () => {
    const machine = run(
      [
        { type: "hidden", atMs: 100 },
        { type: "visible", atMs: 100 + 29999, secureContext: true },
      ],
      streaming(),
    );
    expect(machine.state).toEqual({ kind: "streaming" });
    expect(machine.hiddenAtMs).toBeNull();
  });

  it("resumes streaming exactly on the lost boundary", () => {
    const machine = run(
      [
        { type: "hidden", atMs: 100 },
        { type: "visible", atMs: 100 + HIDDEN_LOST_MS, secureContext: true },
      ],
      streaming(),
    );
    expect(machine.state).toEqual({ kind: "streaming" });
  });

  it("goes to idle and reports the loss after 30001 ms hidden", () => {
    const machine = run(
      [
        { type: "hidden", atMs: 100 },
        { type: "visible", atMs: 100 + 30001, secureContext: true },
      ],
      streaming(),
    );
    expect(machine.state).toEqual({ kind: "idle", lost: true });
    expect(machine.hiddenAtMs).toBeNull();
  });

  it("re-requests the camera on the visibility after a lost stream", () => {
    const lost = run([{ type: "track_ended" }], streaming());
    const machine = scanReducer(lost, { type: "visible", atMs: 1, secureContext: true });
    expect(machine.state).toEqual({ kind: "requesting" });
  });

  it("does not re-request on an insecure context", () => {
    const lost = run([{ type: "track_ended" }], streaming());
    const machine = scanReducer(lost, { type: "visible", atMs: 1, secureContext: false });
    expect(machine.state).toEqual({ kind: "error", error: "insecure_context" });
  });

  it("leaves an error standing, because the user must still act on it", () => {
    const denied = run([MOUNT, { type: "stream_failed", error: "permission_denied" }]);
    const machine = run(
      [
        { type: "hidden", atMs: 0 },
        { type: "visible", atMs: 60000, secureContext: true },
      ],
      denied,
    );
    expect(machine.state).toEqual({ kind: "error", error: "permission_denied" });
    expect(machine.hiddenAtMs).toBeNull();
  });

  it("leaves a confirmed read standing", () => {
    const machine = run(
      [
        { type: "hidden", atMs: 0 },
        { type: "visible", atMs: 60000, secureContext: true },
      ],
      confirmed(),
    );
    expect(machine.state.kind).toBe("confirmed");
  });

  it("leaves a pending permission prompt alone", () => {
    const machine = run(
      [
        { type: "hidden", atMs: 0 },
        { type: "visible", atMs: 10, secureContext: true },
      ],
      run([MOUNT]),
    );
    expect(machine.state).toEqual({ kind: "requesting" });
  });
});

describe("scanReducer — happy path", () => {
  it("runs mount → streaming → candidate → confirmed → accepted", () => {
    const steps: ScanAction[] = [
      MOUNT,
      STARTED,
      saw(VIN_A, 0),
      saw(VIN_A, 400),
      { type: "accepted", vin: VIN_A, atMs: 500 },
    ];
    const kinds = steps.map((_action, i) => run(steps.slice(0, i + 1)).state.kind);
    expect(kinds).toEqual(["requesting", "streaming", "candidate", "confirmed", "idle"]);
    expect(run(steps).cooldown).toEqual({ [VIN_A]: 500 });
  });
});

const KINDS = ["idle", "requesting", "streaming", "candidate", "confirmed", "error"];

const actionArb: fc.Arbitrary<ScanAction> = fc.oneof(
  fc.record({ type: fc.constant("mount" as const), secureContext: fc.boolean() }),
  fc.constant<ScanAction>({ type: "stream_started" }),
  fc.record({
    type: fc.constant("stream_failed" as const),
    error: fc.constantFrom("permission_denied" as const, "no_camera" as const),
  }),
  fc.record({
    type: fc.constant("decoded" as const),
    sighting: fc.record({
      vin: fc.constantFrom(VIN_A, VIN_B),
      raw: fc.constantFrom(VIN_A, VIN_B),
      checkDigitValid: fc.boolean(),
      symbology: fc.constantFrom("code_39" as const, "data_matrix" as const),
      atMs: fc.integer({ min: 0, max: 60000 }),
    }),
  }),
  fc.constant<ScanAction>({ type: "track_ended" }),
  fc.record({ type: fc.constant("hidden" as const), atMs: fc.integer({ min: 0, max: 60000 }) }),
  fc.record({
    type: fc.constant("visible" as const),
    atMs: fc.integer({ min: 0, max: 60000 }),
    secureContext: fc.boolean(),
  }),
  fc.record({ type: fc.constant("retry" as const), secureContext: fc.boolean() }),
  fc.constant<ScanAction>({ type: "rescan" }),
  fc.record({
    type: fc.constant("accepted" as const),
    vin: fc.constantFrom(VIN_A, VIN_B),
    atMs: fc.integer({ min: 0, max: 60000 }),
  }),
);

describe("scanReducer — properties", () => {
  it("never reaches an unknown state and only grows the cooldown on acceptance", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 40 }), (actions) => {
        let machine = initialScanMachine;
        for (const action of actions) {
          const before = machine;
          machine = scanReducer(before, action);
          expect(KINDS).toContain(machine.state.kind);
          if (action.type === "accepted") {
            expect(machine.cooldown).toEqual({ ...before.cooldown, [action.vin]: action.atMs });
          } else {
            // Reference equality: no other action may rewrite the map at all.
            expect(machine.cooldown).toBe(before.cooldown);
          }
        }
      }),
    );
  });

  it("only ever confirms a VIN that was already the candidate", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 40 }), (actions) => {
        let machine = initialScanMachine;
        for (const action of actions) {
          const before = machine;
          machine = scanReducer(before, action);
          if (machine.state.kind !== "confirmed" || before.state.kind === "confirmed") continue;
          // The only way in is a decode agreeing with the standing candidate.
          expect(before.state.kind).toBe("candidate");
          const prior = before.state.kind === "candidate" ? before.state.sighting.vin : null;
          expect(prior).toBe(machine.state.sighting.vin);
        }
      }),
    );
  });
});
