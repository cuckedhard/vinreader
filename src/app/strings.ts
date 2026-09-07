/**
 * The words more than one screen says.
 *
 * §7 item 5 — "no constant is defined in more than one place in the code" — and a string
 * the user reads is a constant like any other. Each of these was a single §6.4 line typed
 * out by hand on two or three screens, none of them importing another, which is how a
 * reword lands on one screen and the app ends up saying two things about one fact. The
 * ledger's own history is the argument: SH-5 changed three sentences on the Import screen
 * and missed the fourth copy of the same idea, because nothing tied them together.
 *
 * What belongs here is only what is genuinely shared. A sentence one screen says stays in
 * that screen's own file — `failureText.ts`, `proposalView.ts`, `paintHint.ts`,
 * `account/strings.ts` — and a sentence that reads the same but states a *different fact*
 * is not shared at all, it is a collision, and it gets different words (`statusLine.ts`).
 *
 * `strings.test.ts` holds the other half: a source scan that fails if any of these is
 * written out anywhere but here.
 */

/**
 * §5.1's `paint`, as every screen labels it: the Sheet's field, the Import preview's row
 * and the accessible name of its chooser, and the capture screen's heading. §6.4 leaves
 * field labels to §6.2 and §4.8, but "defined once" is not a §6.4 rule.
 */
export const PAINT_LABEL = "Paint code";

/** §6.4, Sheet: *a failed save is **"Could not save"***. The capture screen's save fails the same way. */
export const SAVE_FAILED_TITLE = "Could not save";

/**
 * §6.4, Scan `requesting`: the 1–3 s black frame while iOS opens the camera, where silence
 * reads as a broken app. The capture screen opens a camera the same way and waits the same
 * way, so it says the same thing.
 */
export const STARTING_CAMERA = "Starting camera…";

/**
 * §6.4, the write that did not land: banner **"Couldn't save this VIN"**, with the
 * underlying error printed beneath it in monospace. Both scan paths raise it.
 */
export const WRITE_FAILED_TITLE = "Couldn't save this VIN";

/**
 * §6.4 records two wordings of *"Nothing was written"* — the camera path's and the typed
 * path's — because the remedy differs and the opening does not. The capture screen added a
 * third opening, *"Nothing was saved."*, for the same fact, which is how one family
 * becomes four sentences.
 *
 * The clause is the same words in all three; what follows it is what the user can do next,
 * and that is genuinely per-screen: read the label again, the entry is still in the field,
 * the code is still in the control that was tapped. So the shared half is shared and the
 * remedies stay where they are.
 */
export const NOTHING_WRITTEN = "Nothing was written.";
