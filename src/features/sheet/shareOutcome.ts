/**
 * What a rejected `navigator.share()` actually means — and what it does not.
 *
 * §6.4 has a line for a share that did not finish, and until SH-3 it was unreachable: the
 * handler returned on every `AbortError`, on the reading that backing out of the system
 * sheet is a choice and not a fault. Chromium does not report it that way. In
 * `navigator_share.cc`, `ShareClientImpl::Callback` sends **everything except**
 * `PERMISSION_DENIED` to `kAbortError`:
 *
 *   CANCELED        → AbortError "Share canceled"
 *   INTERNAL_ERROR  → AbortError "Share failed"
 *   (mojo dropped)  → AbortError "Internal error: could not connect to Web Share interface."
 *
 * and the Android producers of INTERNAL_ERROR are real field failures: no window or activity,
 * a temp file that could not be created (a full disk), a blob that could not be read
 * (`ShareServiceImpl.java`). All three looked like a deliberate cancel, so the user tapped
 * Share, watched nothing happen, and was told nothing (P7).
 *
 * The message is the only thing that separates them — the W3C spec blurs cancel and failure
 * on purpose, so no engine promises more than this and this function cannot invent it (N2):
 *
 *   · a rejection that is not an AbortError at all is a failure. `NotAllowedError`
 *     ("Permission denied") is SH-1's refused file and the permissions-policy and
 *     transient-activation refusals; `InvalidStateError` is a share already in flight;
 *     a `TypeError` is data this app built wrong. None of them is a user's choice.
 *   · an AbortError carrying one of Chromium's two internal-failure messages is a failure.
 *   · every other AbortError is treated as a cancel, and says nothing.
 *
 * What that last line cannot see, stated rather than hidden: an internal failure in an engine
 * whose wording is not Chromium's — WebKit's cancel and its failures are one `AbortError` with
 * WebKit's own text — and MDN's "no share targets available", which no Chromium string names.
 * Those stay silent. The trade is deliberate: a banner shown to someone who deliberately
 * backed out of the sheet is a guess presented as a fact, and nothing was lost when they did,
 * while the failures this does catch are the ones the reported platform actually produces.
 */

/** `ErrorToString` (INTERNAL_ERROR) and `ShareClientImpl::OnConnectionError`, verbatim. */
const INTERNAL_FAILURES: ReadonlySet<string> = new Set([
  "Share failed",
  "Internal error: could not connect to Web Share interface.",
]);

export type ShareOutcome = "cancelled" | "failed";

export function shareOutcome(cause: unknown): ShareOutcome {
  if (!(cause instanceof DOMException) || cause.name !== "AbortError") return "failed";
  return INTERNAL_FAILURES.has(cause.message.trim()) ? "failed" : "cancelled";
}
