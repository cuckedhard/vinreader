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
