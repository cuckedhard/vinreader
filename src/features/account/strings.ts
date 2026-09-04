/**
 * Every word the Account screen puts on screen, in one file.
 *
 * Two kinds live here and the comments keep them apart, because the difference matters to
 * anyone auditing this slice against the spec:
 *
 * - **§6.4 copy is verbatim.** Same words, same punctuation, straight apostrophes as the
 *   spec writes them. Where a sentence carries a number it is a format rather than a
 *   constant, and §6.4's own example ("Add the 14 records…") is the shape it is formatted
 *   to. Singular is an inflection of that same sentence, not a second one: "Add the 1
 *   record" is not English, and a field app that cannot count to one loses trust it needs
 *   for the numbers that matter.
 * - **Supplied strings** are the ones §6.4 does not have — button labels, section headings,
 *   and the failure text for auth outcomes the spec never enumerated. They are named
 *   constants here rather than literals in JSX so the S4 session report can list them and
 *   `harden` can find them in one place (§0 rule 4).
 */
import type { AuthFailure } from "../../lib/auth/session";

/* ------------------------------------------------------------------ §6.4, verbatim */

export const SIGN_IN_PROMPT = "Enter your email. We'll send a 6-digit code.";
export const CODE_SENT = "Check your email for the code.";
export const CODE_MISMATCH = "That code didn't match. Try again or resend.";

/** §6.4: *"Add the 14 records on this phone to your account?"* → **Add** / **Not now**. */
export function uploadPromptQuestion(records: number): string {
  return records === 1
    ? "Add the record on this phone to your account?"
    : `Add the ${records} records on this phone to your account?`;
}
export const UPLOAD_ADD = "Add";
export const UPLOAD_NOT_NOW = "Not now";

/** §6.4: *"Keep the records on this phone?"* → **Keep** / **Clear this phone**. */
export const SIGN_OUT_QUESTION = "Keep the records on this phone?";
export const SIGN_OUT_KEEP = "Keep";
export const SIGN_OUT_CLEAR = "Clear this phone";

/** §6.4: the typed confirmation, and the sentence both deletes carry. */
export const CONFIRM_WORD = "DELETE";
export const DELETE_WARNING =
  "This removes your VIN history from your account on every device. It can't be undone.";

/* --------------------------------------------------------------- supplied (§0 rule 4) */

export const SCREEN_TITLE = "Account";

/**
 * §5.1's `ready` gate, in words. The session is read asynchronously, so until it answers the
 * screen may show neither a sign-in form nor a signed-in panel — showing either would be a
 * guess about who is holding the phone (N2).
 */
export const CHECKING = "Checking…";

/** `getSupabase()` returned null with no env vars: expected, quiet, and not the user's fault. */
export const NOT_CONFIGURED_TITLE = "Sign-in isn’t set up in this build";
export const NOT_CONFIGURED_BODY =
  "Everything else works as usual — scans, details and handoff all stay on this phone.";

/** The loud one (P7): both variables are set and the client still refused them. */
export const INVALID_CONFIG_TITLE = "Sign-in is misconfigured in this build";
export const INVALID_CONFIG_BODY =
  "The account settings this app was built with aren’t valid, so sign-in can’t be offered. Records stay on this phone.";

export const EMAIL_LABEL = "Email";
export const EMAIL_PLACEHOLDER = "you@example.com";
export const SEND_CODE = "Send code";
export const CODE_LABEL = "6-digit code";
export const CODE_PLACEHOLDER = "123456";
export const SIGN_IN = "Sign in";
export const SENDING = "Sending…";
export const SIGNING_IN = "Signing in…";
export const RESEND = "Resend code";
export const CHANGE_EMAIL = "Use a different email";

/** §9-S4's 30 s, as the button reads while it runs down. `useAuth` owns the clock. */
export function resendIn(seconds: number): string {
  return `Resend in ${seconds} s`;
}

export const SIGNED_IN_AS = "Signed in as";
export const SYNC_TITLE = "Sync";
/** §6.2's "pending count", labelled. §5.7: the count is rows in the outbox. */
export const PENDING_LABEL = "Waiting to upload";
export const LAST_UPLOAD_LABEL = "Last upload";
export const LAST_DOWNLOAD_LABEL = "Last download";
export const NEVER = "Never";
export const SYNC_NOW = "Sync now";
export const SYNCING_NOW = "Syncing…";
export const SYNC_UNAVAILABLE = "Sync isn’t running in this session. Reload the app to start it.";
/** Where §6.4's *"Sync error — tap for details"* lands. The detail is §5.8's `lastError`. */
export const SYNC_ERROR_TITLE = "Sync error";
export const SYNC_OFF_TITLE = "Sync is off";
export const SYNC_OFF_BODY =
  "Scans stay on this phone until you add them. Nothing has been lost — the queue is waiting.";

/** §6.2's "Add N local records". */
export function addLocalRecordsLabel(records: number): string {
  return records === 1 ? "Add 1 local record" : `Add ${records} local records`;
}
export const ADDING = "Adding…";
export const ADDED_TITLE = "Records queued";
export const ADDED_BODY = "They upload in the background. You can leave this screen.";

export const SIGN_OUT = "Sign out";
export const SIGN_OUT_TITLE = "Sign out";
export const SIGNING_OUT = "Signing out…";
/** §6.2 names the two sign-outs; §6.4 gives the question and the two words on the buttons. */
export const SIGN_OUT_BODY =
  "Keep ends the session and leaves every record on this phone. Clear this phone removes the records, the queue and the session — use it on a shared or borrowed phone.";
export const SIGNED_OUT_KEPT_TITLE = "Signed out";
export const SIGNED_OUT_KEPT_BODY =
  "The records on this phone are untouched. Sign in again to add them to an account.";
export const SIGNED_OUT_CLEARED_TITLE = "Signed out and cleared";
export const SIGNED_OUT_CLEARED_BODY =
  "No records, no queue and no session are left on this phone.";
export const CANCEL = "Cancel";

export const DANGER_TITLE = "Delete";
export const DELETE_CLOUD = "Delete my cloud data";
export const DELETE_ACCOUNT = "Delete account";
/**
 * §9-S4 for the account case: "then signs out and clears the device". §6.4's sentence does
 * not say that, and a user cannot consent to what they were not told.
 */
export const DELETE_ACCOUNT_EXTRA = "Your account goes with it, and this phone is cleared.";
export function confirmWordHint(word: string): string {
  return `Type ${word} to turn on the button`;
}
export const DELETING = "Deleting…";
export const CLOUD_DELETED_TITLE = "Cloud data deleted";
export const CLOUD_DELETED_BODY =
  "Your account is empty. The records on this phone are still here, and nothing is queued to upload.";
export const ACCOUNT_DELETED_TITLE = "Account deleted";
export const ACCOUNT_DELETED_BODY = "The account is gone and this phone has been cleared.";

/** P7: something failed and the screen has to say so without blaming the user. */
export const ACTION_FAILED_TITLE = "That didn’t work";

/**
 * `AuthFailure` → words. §6.4 covers exactly one of these — the wrong code — so the rest are
 * supplied. None of them blames the user, and none of them guesses at a cause the client
 * cannot see; `session.ts`'s own message is rendered beneath as the detail (P7).
 */
export const AUTH_FAILURE_TEXT: Record<AuthFailure, string> = {
  not_configured: NOT_CONFIGURED_TITLE,
  cooldown: "The last code is still on its way. Give it a moment.",
  invalid_email: "That address doesn’t look like an email.",
  no_pending_code: "Send a code first, then enter it here.",
  invalid_code: CODE_MISMATCH,
  rate_limited: "Too many attempts. Wait a minute, then try again.",
  offline: "No signal — that didn’t reach the sign-in service. Try again when you’re back online.",
  unknown: "Sign-in didn’t go through. Try again.",
};

/** P7: total to TypeScript, and still total at runtime if a future member arrives. */
export function authFailureText(reason: AuthFailure): string {
  return AUTH_FAILURE_TEXT[reason] ?? AUTH_FAILURE_TEXT.unknown;
}
