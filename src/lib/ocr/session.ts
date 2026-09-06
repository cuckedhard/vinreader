/**
 * What the paint-code capture screen is doing, as a value.
 *
 * The screen itself renders this and nothing else decides anything: `vitest.config.ts`
 * pins `environment: "node"` with no jsdom, so a rule that lives inside a component can
 * only ever be checked through a browser, and the repo has shipped guards that could not
 * fail for exactly that reason. Every decision this flow makes is therefore here, pure,
 * and covered by tests that can be driven red by changing the rule.
 *
 * The rule that matters most is the one that is *absent*. There is no action that accepts
 * a proposal, no confidence at which a state becomes "accepted", and no path from
 * `reading` to anything stored. §5 and N2: a paint code has no check digit, no grammar and
 * no downstream lookup, so nothing can ever contradict a wrong one — auto-accepting saves
 * one tap on an optional field and deletes the last check in the system. The proposal is
 * the end of this machine; the human is what happens next.
 */
import { OCR_TOTAL_BYTES } from "./assets.generated";
import { OCR_VOTE_FRAMES } from "./constants";
import type { OcrSupport } from "./support";
import type { OcrFailure, OcrLine, OcrProgress } from "./types";
import { voteOnLines, type PaintProposal } from "./vote";

export type PaintCaptureState =
  /** This device cannot run the engine at all (`support.ts`). Typing is the route. */
  | { kind: "unsupported"; reason: Exclude<OcrSupport, "ready"> }
  /** Nothing has been downloaded or read yet, and the user has not asked for either. */
  | { kind: "offer" }
  /** The one-time engine download, in bytes the screen can render honestly. */
  | { kind: "downloading"; loadedBytes: number; totalBytes: number }
  /** Reading stills. `lines.length` of `total` are in. */
  | { kind: "reading"; lines: readonly OcrLine[]; total: number }
  /** A proposal for a person to confirm, correct, or throw away. Never a fact. */
  | { kind: "proposal"; proposal: PaintProposal }
  /** Every frame was read and none of them carried anything. */
  | { kind: "nothing" }
  | { kind: "failed"; reason: OcrFailure };

export type PaintCaptureAction =
  | { type: "start" }
  | { type: "progress"; progress: OcrProgress }
  | { type: "read"; line: OcrLine }
  | { type: "failed"; reason: OcrFailure };

/** Whether a run is in flight, which is the only time an in-flight event means anything. */
function running(state: PaintCaptureState): boolean {
  return state.kind === "downloading" || state.kind === "reading";
}

export function initialPaintCaptureState(support: OcrSupport): PaintCaptureState {
  return support === "ready" ? { kind: "offer" } : { kind: "unsupported", reason: support };
}

export function paintCaptureReducer(
  state: PaintCaptureState,
  action: PaintCaptureAction,
): PaintCaptureState {
  switch (action.type) {
    case "start":
      // A device that cannot run the engine is not made able by tapping, and a run already
      // in flight is not restarted by a second tap on a control that is still on screen
      // (the double-tap case A-02 filed on the scanner).
      if (state.kind === "unsupported" || running(state)) return state;
      return { kind: "downloading", loadedBytes: 0, totalBytes: OCR_TOTAL_BYTES };

    case "progress":
      // Progress from a run that is over belongs to nothing on screen. A late event
      // dragging a proposal back into a progress bar is how a read gets thrown away.
      if (state.kind !== "downloading") return state;
      // `file: null` is `ensureOcrAssets` saying every asset is on the device — the moment
      // reading actually begins, and the moment a cached engine passes straight through.
      if (action.progress.file === null) return { kind: "reading", lines: [], total: OCR_VOTE_FRAMES };
      return {
        kind: "downloading",
        loadedBytes: action.progress.loadedBytes,
        totalBytes: action.progress.totalBytes,
      };

    case "read": {
      if (state.kind !== "reading") return state;
      const lines = [...state.lines, action.line];
      if (lines.length < state.total) return { kind: "reading", lines, total: state.total };
      const proposal = voteOnLines(lines);
      // Every frame read, nothing on any of them. Said out loud, because the alternative
      // is an empty box the user has to guess the meaning of (P7).
      return proposal === null ? { kind: "nothing" } : { kind: "proposal", proposal };
    }

    case "failed":
      // Same reasoning as `progress`: a failure belongs to the run that was in flight.
      return running(state) ? { kind: "failed", reason: action.reason } : state;
  }
}
