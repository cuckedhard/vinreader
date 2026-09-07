/**
 * What the sheet is allowed to say about where a paint code came from.
 *
 * It is a rule and not a string, so it lives in a pure sibling the way `copyTexts.ts`,
 * `shareOutcome.ts` and `shareFile.ts` do: `vitest.config.ts` pins `environment: "node"`,
 * and a rule inside a React file cannot be unit-tested in this repo at all.
 *
 * The rule is N2, and there are three answers rather than two because the record has three
 * states, not two (`PaintSource`, §5.1):
 *
 *   · **`"ocr"`** — the capture screen saved a string the engine returned and a person
 *     tapped with the characters inside the control.
 *   · **`"typed"`** — a person put these characters here on this phone: the field below,
 *     the capture screen's typed escape, a per-character correction, a lookalike picked
 *     off `confusion.ts`'s table.
 *   · **`null`** — *this device does not know* (`upsert.ts`). A code that arrived in a
 *     payload, a code a sync pull won with (`merge.ts`), a row written before layer 2
 *     existed. Nothing came with those characters to say who read them.
 *
 * The third one is why this file exists. A paint code has no check digit, no grammar and
 * no downstream lookup (§4.9), so a sentence about its provenance is never contradicted by
 * anything — which is exactly the case N2 covers. Where this device does not know, the
 * sheet says the half it does know and stops, rather than picking whichever of the other
 * two sounds most likely.
 *
 * And with no code stored there is no provenance to describe at all: the same paragraph is
 * the field's own explanation, so it may not read as a claim about characters that are not
 * there.
 */
import type { PaintSource } from "../../lib/vin/types";

/** True however the characters got there, and true when there are none (§7 item 5). */
export const PAINT_NOT_DECODED = "The VIN doesn't carry it and NHTSA doesn't publish it.";

/**
 * S5 layer 2. The two ways a code gets onto this phone are not equally checked — a person
 * typing has read the sticker character by character; a person confirming a camera read has
 * looked at six characters at once, on a control they may have tapped without reading (§5's
 * stated risk) — and the sheet is where someone reads the code out at a paint counter three
 * weeks later.
 *
 * What is deliberately not here is the number. `paintConfidence` is stored and never
 * rendered: §13.7 records that there is no corpus of real door-jamb stickers, so a
 * percentage would be uncalibrated for this task.
 */
export const PAINT_HINT_OCR = `Read off the sticker by the camera on this phone. ${PAINT_NOT_DECODED}`;

/**
 * "By hand", not "from the paint sticker": the app watched a person put characters in, and
 * it never saw what they were reading from. A work order, a paint can and an email all
 * reach this field the same way the sticker does (N2).
 */
export const PAINT_HINT_TYPED = `Entered by hand on this phone. ${PAINT_NOT_DECODED}`;

/** The one sentence under the field, for the record as it is stored. */
export function paintHint(paint: string | null, source: PaintSource): string {
  if (paint === null || paint === "") return PAINT_NOT_DECODED;
  if (source === "ocr") return PAINT_HINT_OCR;
  if (source === "typed") return PAINT_HINT_TYPED;
  return PAINT_NOT_DECODED;
}
