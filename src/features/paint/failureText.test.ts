/**
 * Which sentence each refusal earns, and the two rules that decide it.
 *
 * Three of these states are unreachable from a browser test and one of them is unreachable
 * from anywhere except a bad build, which is exactly why the wrong sentence sat on them:
 * `dictionary_present` is a property of the bytes a build shipped, `busy` needs two
 * recognitions at once, and `no_wasm` needs a browser without WebAssembly. Nothing in the
 * e2e suite can reach any of the three, so the mapping is pinned here.
 */
import { describe, expect, it } from "vitest";

import type { OcrFailure } from "../../lib/ocr/types";
import {
  BUSY,
  CANNOT_RUN,
  CORRUPT_ASSET,
  ENGINE_FAILED,
  UNUSABLE_BUILD,
  failureText,
  isDeadEnd,
  retryCanHelp,
} from "./failureText";

/** §4's `OcrFailure`, pinned here the way N6 asks tests to pin a constant. */
const EVERY_REASON: readonly OcrFailure[] = [
  "no_wasm",
  "no_simd",
  "no_worker",
  "no_canvas",
  "no_cache",
  "scanner_live",
  "aborted",
  "download_failed",
  "corrupt_asset",
  "dictionary_present",
  "engine_failed",
  "busy",
];

/** Refusals that are the same refusal on the next tap, and on every tap after it. */
const NO_RETRY_CAN_HELP: readonly OcrFailure[] = [
  "no_wasm",
  "no_simd",
  "no_worker",
  "no_canvas",
  "no_cache",
  "dictionary_present",
];

describe("every refusal says something, and says it once", () => {
  it("covers §4's whole `OcrFailure` union (P7: never a swallowed exception)", () => {
    for (const reason of EVERY_REASON) {
      expect(failureText(reason), reason).toMatch(/\S/);
    }
  });

  it("leaves the typed field named wherever the camera route is closed", () => {
    for (const reason of NO_RETRY_CAN_HELP) {
      expect(failureText(reason), reason).toContain("Type the code");
    }
  });
});

describe("a cause the client cannot see (N2)", () => {
  it("does not call a missing capability a setting the user turned off", () => {
    // `support.ts` tests for the *absence* of `WebAssembly`. An old browser, a stripped
    // embedded WebView and a Lockdown-Mode iPhone all produce that one signal, so naming
    // any of them is a guess — and "WebAssembly" is not a word this screen's user has.
    expect(failureText("no_wasm")).not.toMatch(/webassembly/i);
    expect(failureText("no_wasm")).not.toMatch(/turned off|switched off|disabled/i);
  });

  it("gives all five capability refusals the one sentence that is true of all five", () => {
    for (const reason of ["no_wasm", "no_simd", "no_worker", "no_canvas", "no_cache"] as const) {
      expect(failureText(reason), reason).toBe(CANNOT_RUN);
    }
  });
});

describe("a remedy the user can actually carry out (§6.4)", () => {
  it("never offers a retry that fetches the same bytes and fails identically", () => {
    // The digest has already matched by the time `assets.ts` looks for a dictionary, so
    // these are the bytes this build shipped. "The reader didn't download cleanly. Try
    // again" was false twice over: it named a transfer that succeeded, and it asked for a
    // tap that can never do anything.
    expect(failureText("dictionary_present")).toBe(UNUSABLE_BUILD);
    expect(failureText("dictionary_present")).not.toBe(CORRUPT_ASSET);
    expect(failureText("dictionary_present")).not.toMatch(/download/i);
    for (const reason of NO_RETRY_CAN_HELP) {
      expect(failureText(reason), reason).not.toMatch(/try again/i);
    }
  });

  it("keeps the retry where a retry is the remedy", () => {
    // `corrupt_asset` is the transfer fault the shared sentence used to describe, and it
    // keeps both the sentence and the retry.
    expect(failureText("corrupt_asset")).toBe(CORRUPT_ASSET);
    expect(CORRUPT_ASSET).toMatch(/try again/i);
    expect(failureText("download_failed")).toMatch(/try again/i);
  });

  it("does not say the reader stopped while it is running", () => {
    // `engine.ts`: one worker, one instance — `busy` is thrown *because* a recognition is
    // already in flight. It shared "The reader stopped." with `engine_failed`, which is
    // the opposite of what happened, and the remedy is to wait rather than to retry into
    // the same refusal.
    expect(failureText("busy")).toBe(BUSY);
    expect(failureText("busy")).not.toBe(ENGINE_FAILED);
    expect(failureText("busy")).not.toMatch(/stopped/i);
    expect(failureText("busy")).toMatch(/already running/i);
    // The one it used to share a sentence with keeps it: that engine really did stop.
    expect(failureText("engine_failed")).toBe(ENGINE_FAILED);
    expect(ENGINE_FAILED).toMatch(/stopped/i);
  });
});

describe("the sentence and the button under it (§6.3's rule for this screen)", () => {
  it("marks exactly the refusals another tap cannot change", () => {
    for (const reason of EVERY_REASON) {
      expect(retryCanHelp(reason), reason).toBe(!NO_RETRY_CAN_HELP.includes(reason));
    }
  });

  it("never asks for a retry the screen does not offer, or offers one it does not ask for", () => {
    // The screen hides Read again wherever `retryCanHelp` is false, so a sentence saying
    // "Try again" there would name a control that is not on screen — and a sentence that
    // has given up while the button is still live is the screen arguing with itself. One
    // list decides both (§7 item 5).
    for (const reason of EVERY_REASON) {
      expect(/try again/i.test(failureText(reason)), reason).toBe(
        retryCanHelp(reason) && reason !== "busy",
      );
    }
    // `busy` is the one retryable refusal whose remedy is to wait first, so it says that
    // instead — and the button stays.
    expect(retryCanHelp("busy")).toBe(true);
    expect(BUSY).toMatch(/wait/i);
  });
});

describe("what the screen and the camera do with a refusal", () => {
  it("is a dead end only where no second tap can change the answer", () => {
    // The screen drops the preview and the Read again button on this, and the hook releases
    // the camera on it. Both read this one function, so a refusal cannot be a dead end for
    // one of them and not the other.
    expect(isDeadEnd({ kind: "unsupported", reason: "no_wasm" })).toBe(true);
    expect(isDeadEnd({ kind: "failed", reason: "dictionary_present" })).toBe(true);
    expect(isDeadEnd({ kind: "failed", reason: "no_cache" })).toBe(true);

    // Everything a tap can still change keeps the camera and the button.
    for (const reason of EVERY_REASON.filter((each) => retryCanHelp(each))) {
      expect(isDeadEnd({ kind: "failed", reason }), reason).toBe(false);
    }
    expect(isDeadEnd({ kind: "offer" })).toBe(false);
    expect(isDeadEnd({ kind: "nothing" })).toBe(false);
  });
});
