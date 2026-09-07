/**
 * What the capture screen says while it is working, and never a claim about the answer.
 *
 * A rule, not a list of strings, so it lives in a pure sibling for the reason
 * `proposalView.ts` and `failureText.ts` give about themselves: `vitest.config.ts` pins
 * `environment: "node"`, so a rule inside a React file cannot be unit-tested in this repo
 * at all — and the states this one is about are the two nothing else can hold still. A
 * download and a five-frame read are over before a browser test can read them.
 *
 * The `reading` line used to be *"Reading… hold steady (3 of 5)"*, which is §6.4's Scan
 * `candidate` sentence with a counter bolted on. Those are not the same fact. On the scan
 * screen it means **a first VIN has been seen and a second read is wanted** — the state
 * §6.3 gives 1.5 s to agree with itself; here it means frames are being captured and there
 * is no candidate in the screen at all. One sentence for two facts is worse than two
 * sentences, because the reader who learns it on one screen carries the wrong meaning to
 * the other. So this one is shaped like the download line above it — the thing being done,
 * then where it has got to — and keeps the instruction that is actually true of both.
 *
 * `app/strings.test.ts` holds the other half: "Reading… hold steady" belongs to
 * `CameraView` and fails the build anywhere else.
 */
import { STARTING_CAMERA } from "../../app/strings";
import type { PaintCaptureState } from "../../lib/ocr/session";

export const AIM = "Put the box on the paint code.";
export const NOTHING = "Nothing readable in the box.";

/**
 * Megabytes as a data plan counts them, not as a disk does. The number under the Read
 * button is the one the user is deciding about, and 4.5 against 4.3 for the same bytes is
 * the kind of difference that reads as a lie on a metered connection. Both the offer and
 * the progress line go through here, so they cannot disagree (§7 item 5).
 */
const MEGABYTE = 1_000_000;

export function megabytes(bytes: number): string {
  return (bytes / MEGABYTE).toFixed(1);
}

export function statusLine(state: PaintCaptureState, cameraReady: boolean): string | null {
  switch (state.kind) {
    case "offer":
      return cameraReady ? AIM : STARTING_CAMERA;
    case "downloading":
      return `Downloading the reader… ${megabytes(state.loadedBytes)} of ${megabytes(state.totalBytes)} MB`;
    case "reading":
      return `Reading the code… ${state.lines.length + 1} of ${state.total}. Hold steady.`;
    case "nothing":
      return NOTHING;
    case "proposal":
    case "unsupported":
    case "failed":
      return null;
  }
}
