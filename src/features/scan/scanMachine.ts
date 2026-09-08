/**
 * §6.3 scanner state machine. `scanReducer` is pure: no DOM, no React, no timers
 * and no clock reads — every time value arrives inside an action, so the whole of
 * §6.3 is testable without a camera. `startingScanMachine` is the one export that
 * looks outside itself, and only to seed a cooldown that has to outlive the
 * component the reducer runs in.
 */

import { cooldownStore } from "./cooldownStore";
import type { NoVin, ScanError, Symbology } from "../../lib/vin/types";

/** §6.3 two-read agreement window. */
export const CONFIRM_WINDOW_MS = 1500;

/** §6.3 same-VIN cooldown; stops a return to the Scan screen double-logging. */
export const COOLDOWN_MS = 10000;

/** §6.3 a tab hidden longer than this counts as a lost stream. */
export const HIDDEN_LOST_MS = 30000;

export interface ScanSighting {
  vin: string;
  raw: string;
  checkDigitValid: boolean;
  symbology: Symbology;
  atMs: number;
}

export type ScanMachineState =
  | { kind: "idle"; lost: boolean }
  | { kind: "requesting" }
  | { kind: "streaming" }
  | { kind: "candidate"; sighting: ScanSighting }
  | { kind: "confirmed"; sighting: ScanSighting }
  | { kind: "error"; error: ScanError };

export interface ScanMachine {
  state: ScanMachineState;
  /** VIN → the time it was accepted and persisted. Only "accepted" writes here. */
  cooldown: Record<string, number>;
  hiddenAtMs: number | null;
  /**
   * A read §4.2 refused that two frames agree on, and therefore the one thing on this
   * screen worth saying about a refusal (FR-2). `null` is silence, which is what most
   * refusals get: §6.4 rules that garbage keeps the scanner going, and the decoder misses
   * several times a second.
   *
   * It is deliberately **not** a `ScanState`. §4.10's six states are the ones that own the
   * camera and the status line, and a refusal owns neither — the stream keeps running
   * (N1), the status line keeps pointing at the door-jamb sticker, and nothing is written.
   * Adding a seventh would be a change to a §4 constant for a banner.
   */
  refusal: NoVin | null;
  /**
   * The last refusal a frame reported, waiting for a second frame to agree with it.
   * §6.3's two-read agreement, applied to the refusal rather than to a VIN and on §6.3's
   * own window — not a second timing rule.
   */
  refusalSeen: { refusal: NoVin; atMs: number } | null;
}

/**
 * No refusal, agreed or pending. Spread wherever the machine restarts the camera or takes
 * in a VIN or one of the app's own §4.9 codes (FR-3), because a refusal is about the code in
 * the frame and each of those is a fresh look at the scene (R3-F5: a notice that outlives
 * what it describes is a guess shown as a fact, N2).
 *
 * `rescan` and `accepted` deliberately do NOT spread it, and it is not an omission: both
 * act on a `confirmed` machine, `decoded` is the only way into `confirmed`, and `decoded`
 * has already cleared it. Clearing it again would be a statement no test could tell from
 * its own absence — the same thing §4.2 step 4b's removed `if` was, and the same thing
 * `bun run mutate` reports.
 */
const NO_REFUSAL = { refusal: null, refusalSeen: null } as const;

export type ScanAction =
  | { type: "mount"; secureContext: boolean }
  | { type: "stream_started" }
  | { type: "stream_failed"; error: ScanError }
  | { type: "decoded"; sighting: ScanSighting }
  /**
   * A frame that decoded cleanly and is not a VIN, with §4.2's reason (FR-1). Frames that
   * decode nothing at all never reach here — ZXing's miss is not a read of anything, and
   * §6.4 rules that garbage keeps the scanner going.
   */
  | { type: "refused"; refusal: NoVin; atMs: number }
  /**
   * One of the app's own §4.9 carriers in the frame (FR-3). It carries no payload and moves
   * no state: the screen owns §6.4's rejection and the route it opens, and §4.10 gains no
   * state for a carrier — a carrier read owns neither the camera nor the status line, exactly
   * as a refusal does not. All this says is that the frame has moved on.
   */
  | { type: "carrier" }
  /**
   * The §6.3 agreement window running out under a standing candidate. The hook owns the
   * timer and stamps the instant; the reducer only compares it, so P3 holds.
   */
  | { type: "tick"; atMs: number }
  | { type: "track_ended" }
  | { type: "hidden"; atMs: number }
  | { type: "visible"; atMs: number; secureContext: boolean }
  | { type: "retry"; secureContext: boolean }
  | { type: "rescan" }
  | { type: "accepted"; vin: string; atMs: number };

export const initialScanMachine: ScanMachine = {
  state: { kind: "idle", lost: false },
  cooldown: {},
  hiddenAtMs: null,
  ...NO_REFUSAL,
};

/**
 * The machine a mount starts from. §6.3's cooldown guards "return to Scan", and
 * that return is a fresh React mount — so the cooldown is seeded from a store that
 * outlives the screen rather than from whatever the last component instance held.
 * `initialScanMachine` stays empty because the reducer's own tests start clean, and
 * the reducer itself never touches the store: a reducer that read module state
 * would not be pure.
 */
export function startingScanMachine(
  cooldown: Record<string, number> = cooldownStore.read(),
): ScanMachine {
  return { ...initialScanMachine, cooldown };
}

/** §6.3: an insecure context is an error before any permission prompt happens. */
function cameraStart(secureContext: boolean): ScanMachineState {
  return secureContext ? { kind: "requesting" } : { kind: "error", error: "insecure_context" };
}

/**
 * Whether a track is live, so decodes and track events are real. A hidden tab is
 * not live even while the state kind still reads `streaming`: the camera is
 * released on `hidden`, but ZXing's decode loop can still call back once from a
 * timer tick that was already queued, and that frame must not rebuild the
 * candidate `hidden` just dropped.
 */
function isLive(machine: ScanMachine): boolean {
  if (machine.hiddenAtMs !== null) return false;
  return machine.state.kind === "streaming" || machine.state.kind === "candidate";
}

/**
 * Both §6.3 windows are two-sided. Timestamps come from `Date.now()`, which follows
 * the wall clock, so after a backwards correction a one-sided `gap <= bound` reads
 * every earlier acceptance as "still cooling down" for the whole of the jump. A
 * sighting stamped before the thing it is measured against is not within any window
 * of it. The bound itself stays inclusive: a gap of exactly the constant is inside.
 */
function isWithin(gapMs: number, windowMs: number): boolean {
  return gapMs >= 0 && gapMs <= windowMs;
}

/** §6.3 cooldown, consulted rather than expired: entries are compared, never swept. */
function isCoolingDown(machine: ScanMachine, vin: string, atMs: number): boolean {
  const acceptedAt = machine.cooldown[vin];
  return acceptedAt !== undefined && isWithin(atMs - acceptedAt, COOLDOWN_MS);
}

export function scanReducer(machine: ScanMachine, action: ScanAction): ScanMachine {
  switch (action.type) {
    case "mount":
    case "retry":
      // Retry re-runs the mount logic, so an insecure context stays an error.
      // The cooldown map survives: returning to Scan is exactly what it guards.
      return {
        ...machine,
        ...NO_REFUSAL,
        state: cameraStart(action.secureContext),
        hiddenAtMs: null,
      };

    case "stream_started":
      return machine.state.kind === "requesting"
        ? { ...machine, state: { kind: "streaming" } }
        : machine;

    case "stream_failed":
      // Honoured while the camera is coming up or running. A failure reported
      // after the caller stopped the stream itself must not overwrite a read
      // the user is still acting on.
      if (machine.state.kind === "requesting" || isLive(machine)) {
        return { ...machine, state: { kind: "error", error: action.error } };
      }
      return machine;

    case "decoded": {
      // A late frame from a stopped or hidden stream cannot resurrect a scan.
      if (!isLive(machine)) return machine;
      const { sighting } = action;
      if (isCoolingDown(machine, sighting.vin, sighting.atMs)) return machine;
      const confirms =
        machine.state.kind === "candidate" &&
        machine.state.sighting.vin === sighting.vin &&
        isWithin(sighting.atMs - machine.state.sighting.atMs, CONFIRM_WINDOW_MS);
      // The confirming sighting is the one kept: its raw bytes are what clinched
      // the read and its timestamp is the moment of confirmation.
      //
      // A VIN in the frame ends any refusal: the code that was refused is not what the
      // camera is looking at any more, and the screen has a read to show instead.
      return {
        ...machine,
        ...NO_REFUSAL,
        state: { kind: confirms ? "confirmed" : "candidate", sighting },
      };
    }

    case "refused": {
      // A late frame from a stopped or hidden stream describes a scene nobody is pointing
      // at, exactly as it cannot resurrect a candidate.
      if (!isLive(machine)) return machine;
      const { refusal, atMs } = action;
      const seen = machine.refusalSeen;
      // §6.3's two-read agreement, on §6.3's own window and its own constant. It is what
      // separates a coherent read that is not a VIN from frame noise: a symbol in front of
      // the camera decodes to the same bytes every frame, and a misread does not repeat
      // itself. One sighting says nothing, which is what keeps the loop from strobing.
      const agrees =
        seen !== null &&
        seen.refusal.raw === refusal.raw &&
        isWithin(atMs - seen.atMs, CONFIRM_WINDOW_MS);
      // The pending read is always replaced — a different code in the frame starts its own
      // window — while what is *shown* only ever changes on agreement, so the banner holds
      // still instead of flickering between two half-read symbols.
      return {
        ...machine,
        refusalSeen: { refusal, atMs },
        refusal: agrees ? refusal : machine.refusal,
      };
    }

    case "carrier": {
      // A late frame from a stopped or hidden stream describes a scene nobody is pointing at,
      // exactly as it cannot resurrect a candidate or raise a refusal.
      if (!isLive(machine)) return machine;
      // FR-3: a §4.9 carrier is a *code* in the frame, so the code a standing refusal is about
      // is not what the camera is looking at any more — the same fact `decoded` reports for a
      // VIN, for the same reason (R3-F5, N2). It has to be said here because `readScanResult`
      // answers a carrier above `extractVinExplained` and nothing else told the machine the
      // frame had moved on: §6.4's "Couldn't read that code" then rendered beside a refusal
      // about a code that had left the frame, two banners each offering "Keep scanning", one
      // of them answering a read no longer on screen (P7). The pending half goes with it, or a
      // frame from before the carrier could agree with one from after it and raise a banner
      // about the code that has just been replaced.
      //
      // Identical when there is nothing to clear, and `refused` is the only writer of either
      // field and always writes both, so an empty `refusalSeen` means an empty `refusal` too.
      // The same code decodes several times a second and a fresh machine per frame would
      // re-render the screen at the decode rate for no change — the property `handleCarrier`'s
      // `setState` of an unchanged string already keeps on this path.
      if (machine.refusalSeen === null) return machine;
      return { ...machine, ...NO_REFUSAL };
    }

    case "tick": {
      // §6.3 gives agreement 1.5 s, and nothing used to leave `candidate` when it ran out:
      // a phone lowered after a single read kept "Reading… hold steady." up over a live
      // preview of nothing, which in the dark reads as "keep holding" for a beep that can
      // never come (Z9). Function was never at stake — every sighting replaces the
      // candidate, so a stale one cannot confirm — but §6.1 makes that line the primary
      // feedback, and it was telling the user something untrue.
      if (machine.state.kind !== "candidate") return machine;
      // Two-sided like every other §6.3 window: a tick stamped before the candidate means
      // the clock moved, and that candidate can no longer confirm against anything either
      // (a sighting measured against a future stamp starts a fresh window), so the line
      // would be as untrue in that direction.
      return isWithin(action.atMs - machine.state.sighting.atMs, CONFIRM_WINDOW_MS)
        ? machine
        : { ...machine, state: { kind: "streaming" } };
    }

    case "track_ended":
      return isLive(machine) ? { ...machine, state: { kind: "idle", lost: true } } : machine;

    case "hidden": {
      // A candidate that survived a pocket and confirmed on return would be a
      // scan the user never took, so the pending read is dropped.
      const state: ScanMachineState =
        machine.state.kind === "candidate" ? { kind: "streaming" } : machine.state;
      return { ...machine, state, hiddenAtMs: action.atMs };
    }

    case "visible": {
      const next: ScanMachine = { ...machine, hiddenAtMs: null };
      // The user must still act on an error or on a confirmed read; coming back
      // to the tab is not that action.
      if (machine.state.kind === "error" || machine.state.kind === "confirmed") return next;
      const gap = machine.hiddenAtMs === null ? 0 : action.atMs - machine.hiddenAtMs;
      // §6.3: a stream hidden past the window is lost and re-requested "on next
      // visibility" — and this event is that next visibility, so the re-request
      // happens here. Stopping at idle left someone back from a pocket looking at a
      // dead preview with no second visibility coming. A machine that is already
      // idle (a dead track, a saved scan) re-requests down the same path, and an
      // insecure context still becomes an error without a permission prompt.
      if (gap > HIDDEN_LOST_MS || machine.state.kind === "idle") {
        return { ...next, ...NO_REFUSAL, state: cameraStart(action.secureContext) };
      }
      return next;
    }

    case "rescan":
      // No cooldown entry: the rejected read was never persisted, so the same
      // VIN must be readable again immediately.
      return machine.state.kind === "confirmed"
        ? { ...machine, state: { kind: "streaming" } }
        : machine;

    case "accepted":
      // The caller reports a persisted read; the cooldown keys on this alone.
      return {
        ...machine,
        state: { kind: "idle", lost: false },
        cooldown: { ...machine.cooldown, [action.vin]: action.atMs },
      };
  }
}
