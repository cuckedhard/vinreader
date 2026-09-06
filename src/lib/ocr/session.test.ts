/**
 * The capture flow, as a value rather than as a component.
 *
 * `vitest.config.ts` pins `environment: "node"` and there is no jsdom in this repo, so a
 * rule that lives inside a React component cannot be unit-tested at all — which is how
 * seven guards have shipped here unable to fail. Every rule this flow has is therefore in
 * `session.ts`, and every one of them is driven red below.
 *
 * The rule with no test of its own is the absence of one: there is no action that accepts a
 * proposal. The last case here is what stands in for it.
 */
import { describe, expect, it } from "vitest";
import { OCR_TOTAL_BYTES } from "./assets.generated";
import { OCR_VOTE_FRAMES } from "./constants";
import {
  initialPaintCaptureState,
  paintCaptureReducer,
  type PaintCaptureAction,
  type PaintCaptureState,
} from "./session";
import type { OcrLine } from "./types";

function read(text: string, confidence = 90): OcrLine {
  return {
    text,
    confidence,
    chars: [...text].map((char) => ({ char, confidence })),
  };
}

function run(state: PaintCaptureState, ...actions: PaintCaptureAction[]): PaintCaptureState {
  return actions.reduce(paintCaptureReducer, state);
}

const READY = initialPaintCaptureState("ready");
const DOWNLOADED = { file: null, loadedBytes: OCR_TOTAL_BYTES, totalBytes: OCR_TOTAL_BYTES };

/** The whole flow: asked for, downloaded, and read `n` times. */
function readingState(): PaintCaptureState {
  return run(READY, { type: "start" }, { type: "progress", progress: DOWNLOADED });
}

describe("initialPaintCaptureState", () => {
  it("offers the read on a device that can run the engine", () => {
    expect(READY).toEqual({ kind: "offer" });
  });

  it("names the missing capability on a device that cannot, before any bytes are spent", () => {
    expect(initialPaintCaptureState("no_wasm")).toEqual({ kind: "unsupported", reason: "no_wasm" });
    expect(initialPaintCaptureState("no_simd")).toEqual({ kind: "unsupported", reason: "no_simd" });
  });
});

describe("paintCaptureReducer", () => {
  it("starts with the download the user is about to pay for, in bytes", () => {
    expect(run(READY, { type: "start" })).toEqual({
      kind: "downloading",
      loadedBytes: 0,
      totalBytes: OCR_TOTAL_BYTES,
    });
  });

  it("cannot be started on a device that cannot run it", () => {
    const unsupported = initialPaintCaptureState("no_wasm");
    expect(run(unsupported, { type: "start" })).toBe(unsupported);
  });

  it("ignores a second tap on a run already in flight", () => {
    const downloading = run(READY, { type: "start" });
    expect(run(downloading, { type: "start" })).toBe(downloading);
    const reading = readingState();
    expect(run(reading, { type: "start" })).toBe(reading);
  });

  it("can be started again after a proposal, a blank, or a failure", () => {
    const blank = run(readingState(), ...Array.from({ length: OCR_VOTE_FRAMES }, () => ({ type: "read" as const, line: read("") })));
    expect(blank.kind).toBe("nothing");
    expect(run(blank, { type: "start" }).kind).toBe("downloading");
    expect(run({ kind: "failed", reason: "engine_failed" }, { type: "start" }).kind).toBe(
      "downloading",
    );
  });

  it("reports the download as it lands", () => {
    const state = run(READY, { type: "start" }, {
      type: "progress",
      progress: { file: "eng.traineddata", loadedBytes: 1000, totalBytes: OCR_TOTAL_BYTES },
    });
    expect(state).toEqual({ kind: "downloading", loadedBytes: 1000, totalBytes: OCR_TOTAL_BYTES });
  });

  it("starts reading the moment every asset is on the device", () => {
    expect(readingState()).toEqual({ kind: "reading", lines: [], total: OCR_VOTE_FRAMES });
  });

  it("does not let a late progress event drag a finished run back into a progress bar", () => {
    const proposal = run(
      readingState(),
      ...Array.from({ length: OCR_VOTE_FRAMES }, () => ({ type: "read" as const, line: read("UG") })),
    );
    expect(proposal.kind).toBe("proposal");
    expect(run(proposal, { type: "progress", progress: DOWNLOADED })).toBe(proposal);
  });

  it("votes only once every frame is in", () => {
    let state = readingState();
    for (let frame = 1; frame < OCR_VOTE_FRAMES; frame += 1) {
      state = run(state, { type: "read", line: read("WA8555") });
      expect(state).toMatchObject({ kind: "reading", total: OCR_VOTE_FRAMES });
      expect(state.kind === "reading" && state.lines.length).toBe(frame);
    }
    state = run(state, { type: "read", line: read("WA8555") });
    expect(state).toMatchObject({ kind: "proposal", proposal: { text: "WA8555", frames: OCR_VOTE_FRAMES } });
  });

  it("proposes the vote's winner, not the last frame in", () => {
    const state = run(
      readingState(),
      { type: "read", line: read("WA8555", 95) },
      { type: "read", line: read("WA8555", 95) },
      { type: "read", line: read("WA8555", 95) },
      { type: "read", line: read("WA8555", 95) },
      { type: "read", line: read("WA8SSS", 20) },
    );
    expect(state).toMatchObject({ kind: "proposal", proposal: { text: "WA8555" } });
  });

  it("says nothing was read rather than proposing an empty string", () => {
    const state = run(
      readingState(),
      ...Array.from({ length: OCR_VOTE_FRAMES }, () => ({ type: "read" as const, line: read("") })),
    );
    expect(state).toEqual({ kind: "nothing" });
  });

  it("drops a read that belongs to no run", () => {
    expect(run(READY, { type: "read", line: read("UG") })).toBe(READY);
  });

  it("carries a failure that ended a run in flight", () => {
    expect(run(readingState(), { type: "failed", reason: "aborted" })).toEqual({
      kind: "failed",
      reason: "aborted",
    });
    expect(
      run(run(READY, { type: "start" }), { type: "failed", reason: "download_failed" }),
    ).toEqual({ kind: "failed", reason: "download_failed" });
  });

  it("does not let a late failure erase a proposal that is already on screen", () => {
    const proposal = run(
      readingState(),
      ...Array.from({ length: OCR_VOTE_FRAMES }, () => ({ type: "read" as const, line: read("UG") })),
    );
    expect(run(proposal, { type: "failed", reason: "aborted" })).toBe(proposal);
  });

  /**
   * §5 / N2. Five frames agreeing at 100 is five frames agreeing, not five checks passing:
   * an OCR confusion comes from the glyph's shape and repeats on every frame of the same
   * sticker in the same light. There is no confidence at which this machine stops needing
   * a person, and this is the assertion that says so.
   */
  it("ends at a proposal at any confidence, however unanimous", () => {
    const state = run(
      readingState(),
      ...Array.from({ length: OCR_VOTE_FRAMES }, () => ({
        type: "read" as const,
        line: read("NH-731P", 100),
      })),
    );
    expect(state.kind).toBe("proposal");
    expect(state).toMatchObject({ proposal: { confidence: 100, agreement: 1, marked: [] } });
  });
});
