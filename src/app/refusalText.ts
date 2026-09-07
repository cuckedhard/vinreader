/**
 * What the app says about a read §4.2 refused: the text it read, and which branch of
 * §4.2 step 4 refused it — one wording for the three surfaces that can refuse one.
 *
 * The report this answers: a mechanic scanned a DYNACRAFT component label on a 2013
 * Kenworth, the app refused every field on it — correctly — and said nothing at all, so
 * the sticker had to be photographed and shown to a person. FR-1 kept the branch as data
 * (`NoVin`); this is the sentence, and `RefusedRead.tsx` is the markup.
 *
 * **Only what the app holds (N2).** It holds the text it decoded, the length of §4.2 step
 * 2's longest run, and the branch that refused. It does not hold what the string *is*:
 * "that is a part number" or "you are at the wrong sticker" are guesses, however good, and
 * the next person scans a pallet tag and is told something false. So every sentence below
 * says what the text is not, and the number behind it, and nothing else.
 *
 * **What is not written here.** The remedy is the surface's, because it differs: the scan
 * screen already says *"Point at the barcode on the door-jamb sticker."* under a live
 * camera, the typed screen has §6.4's *"…Keep typing, or check for a mistyped character."*
 * under the field, and the Import screen has its own hint about what a link and a code
 * look like. A second remedy from here would be a fourth voice on a screen that already
 * answers the question (§7 item 5, and the string inventory's conflict 5).
 *
 * §0 rule 4: §6.4 supplies no copy for this state, so these are supplied and reported.
 * `NOT_A_VIN` is not new — it is §6.4's own line for the typed path, and the scan screen
 * now says it about the same fact rather than inventing a second way to say it.
 */
import type { NoVin } from "../lib/vin/types";

/**
 * §6.4, *"Enough typed, grammar still failing"*, and the camera's own refusal.
 *
 * One state, two ways in: §4.2 was handed something and would not read a VIN out of it.
 * "yet" is as true of the camera as of the keyboard — §6.4 rules that a refused read keeps
 * the scanner going, so there is no VIN *yet* and the next frame may carry one. Writing a
 * second title for the scan screen would put two sentences on one fact, which is the
 * collision `strings.test.ts` exists to stop.
 */
export const NOT_A_VIN = "Not a VIN yet";

/**
 * How much of a read is shown before it is cut.
 *
 * `NoVin.raw` is unbounded — a pasted payload can be a hundred thousand characters — and
 * this text renders at §6.1's VIN size, where a 360 px phone fits about a dozen characters
 * to a line. 48 is four lines at that size: longer than any label field this has been
 * shown (the report's part number is 18), and short enough that the sentence underneath
 * stays on the same screen. What is cut is marked with `…`, the app's own mark for "there
 * is more" (§6.4's *"Starting camera…"*).
 */
export const READ_LIMIT = 48;

/**
 * The read, as much of it as is shown.
 *
 * Code points, not UTF-16 units: `slice` on a lone surrogate would render `�`, which
 * is a character the label does not carry (N2). Nothing else is done to it — no case
 * change, no trim — because the point of showing it is that it is what came back.
 */
export function refusalRead(refusal: NoVin): string {
  const characters = [...refusal.raw];
  if (characters.length <= READ_LIMIT) return refusal.raw;
  return `${characters.slice(0, READ_LIMIT).join("")}…`;
}

/**
 * Why it is not a VIN, in the one fact §4.2 held when it refused.
 *
 * Each line states the count the branch was taken on and stops there:
 * - `no_run_of_17` — the longest run (§4.2 step 2). The report's case: `I`, `O`, `Q`,
 *   hyphens, spaces and punctuation are all separators, so the number quoted is the
 *   longest piece that survived, not the number of characters a reader would count off
 *   the label.
 * - `ambiguous` — how many distinct VINs passed §4.3. Always at least two here, so the
 *   plural is never wrong.
 * - `not_whole_run` — R4-A: one window passed and it was not a run of its own, so where a
 *   VIN starts is exactly what the bytes do not say.
 * - `no_valid_window` — several windows, none of which §4.3 settles.
 */
export function refusalReason(refusal: NoVin): string {
  switch (refusal.reason) {
    case "no_run_of_17":
      return `No 17 characters in a row here — the longest run is ${refusal.longestRun.length}.`;
    case "ambiguous":
      return `${refusal.validCount} different 17-character strings here could each be a VIN, and nothing says which.`;
    case "not_whole_run":
      return "The 17 characters that could be a VIN sit inside a longer string, and nothing says where a VIN starts.";
    case "no_valid_window":
      return "None of the 17-character strings here has a matching check digit.";
  }
}
