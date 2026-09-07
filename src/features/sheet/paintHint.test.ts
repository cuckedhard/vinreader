/**
 * The one sentence under the sheet's paint field, and the three record states it has to be
 * true of.
 *
 * The failure this pins is N2 shown as microcopy rather than as a value: the sheet has no
 * way to check a paint code — no check digit, no grammar, no lookup (§4.9) — so a sentence
 * saying who put it there is never contradicted by anything the app or the user can see.
 * Two of the three states below carry no provenance at all, and both of them used to render
 * a sentence that said a person typed the code off a paint sticker.
 */
import { describe, expect, it } from "vitest";

import {
  PAINT_HINT_OCR,
  PAINT_HINT_TYPED,
  PAINT_NOT_DECODED,
  paintHint,
} from "./paintHint";

describe("what the sheet says about a paint code's provenance", () => {
  it("says only what is true of the field when there is no code", () => {
    // The paragraph is the field's own explanation here, and a field nobody has filled has
    // no provenance to describe. `""` is what a cleared box hands the record before
    // `meaningful` normalises it, so both spellings of "nothing" get the same sentence.
    expect(paintHint(null, null)).toBe(PAINT_NOT_DECODED);
    expect(paintHint("", null)).toBe(PAINT_NOT_DECODED);
    expect(paintHint(null, "typed")).toBe(PAINT_NOT_DECODED);
    expect(paintHint(null, "ocr")).toBe(PAINT_NOT_DECODED);
  });

  it("claims nothing about a code this device did not watch arrive (N2)", () => {
    // `null` is `upsert.ts`'s "this device does not know": a code out of a §4.9 payload,
    // a code a sync pull won with (`merge.ts` nulls the source when the remote value
    // replaces the local one), a row written before layer 2 existed. Nobody on this phone
    // read these characters, and nothing arrived to say who did.
    expect(paintHint("WA8555", null)).toBe(PAINT_NOT_DECODED);
    expect(PAINT_NOT_DECODED).not.toContain("hand");
    expect(PAINT_NOT_DECODED).not.toContain("camera");
    expect(PAINT_NOT_DECODED).not.toContain("sticker");
  });

  it("names the camera only for a string the engine returned", () => {
    expect(paintHint("WA8555", "ocr")).toBe(PAINT_HINT_OCR);
    expect(PAINT_HINT_OCR).toContain("camera on this phone");
  });

  it("names the hand, and not what the hand was reading from", () => {
    expect(paintHint("NH-731P", "typed")).toBe(PAINT_HINT_TYPED);
    // "typed" is also a per-character correction and a lookalike picked off the confusion
    // table, and in none of the three did the app see where the characters came from — a
    // work order, a paint can and an email all reach this field the way a sticker does.
    expect(PAINT_HINT_TYPED).not.toContain("sticker");
    expect(PAINT_HINT_TYPED).not.toContain("camera");
  });

  it("keeps the half nothing can change on every sentence (§7 item 5)", () => {
    for (const source of ["ocr", "typed", null] as const) {
      expect(paintHint("WA8555", source)).toContain(PAINT_NOT_DECODED);
    }
  });
});
