/**
 * Sign-in: email, a 6-digit code, a session (§4.12, §9-S4). Nothing else — §12 rules out
 * passwords and OAuth in v1.
 *
 * ## What lives here and why
 *
 * This module is the whole auth state machine, above React. Three things force that:
 *
 * 1. **N7 — auth never blocks scanning.** Nothing on a write path may await a session or a
 *    request, so the session is *held* here and read synchronously (`getAuthSnapshot`); the
 *    only awaits are the three actions the user explicitly takes. `src/lib/storage/*` does
 *    not import this file, and must not.
 * 2. **The resend cooldown has to survive a re-render.** §9-S4 allows a resend after 30 s.
 *    A timer in component state restarts every time the Account screen re-renders or the
 *    user navigates away and back, which turns "wait 30 s" into "wait 30 s from whenever
 *    you last looked". The clock is module state; `useAuth` only renders it.
 * 3. **One subscription per tab.** supabase-js emits auth events to one listener registered
 *    here, and every consumer — the hook, the sync engine — reads this snapshot. Two
 *    listeners would mean two answers to "who is signed in".
 *
 * ## The contract other slices depend on
 *
 * `getSupabase()` (from `./client`), `getUserId()` and `onAuthChange()` are what
 * `src/lib/sync/` imports, and nothing else. Changing their shapes is a cross-slice change.
 *
 * ## The Supabase project must send the token, not a link
 *
 * §4.12: "the email template must include the token". `signInWithOtp` sends whatever the
 * project's **Magic Link** template contains, and the stock template contains only
 * `{{ .ConfirmationURL }}`. A project left that way emails a link, the user never sees a
 * 6-digit code, `verifyCode` is never reachable, and nothing here reports an error —
 * every call succeeds. The template must include `{{ .Token }}`. That configuration lives
 * in the Supabase dashboard (Authentication → Email Templates → Magic Link) or in
 * `supabase/config.toml` for the local stack; it cannot be asserted from the client, so it
 * is written down here and in the S4 session report.
 */
import type { AuthError, Session, SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "./client";

/** §9-S4: "resend after 30 s". */
export const RESEND_COOLDOWN_MS = 30_000;

/** Where the sign-in flow is. `code_sent` is the only state that can be verified. */
export type AuthStage = "signed_out" | "code_sent" | "signed_in";

/**
 * Why an action did not succeed. The screen owns the words (§6.4); this is the distinction
 * it needs to pick between them, and `message` carries the server's own text for the log
 * and for `invalid_config`-style deployment mistakes no microcopy covers (P7).
 */
export type AuthFailure =
  | "not_configured"
  | "cooldown"
  | "invalid_email"
  | "no_pending_code"
  | "invalid_code"
  | "rate_limited"
  | "offline"
  | "unknown";

export type AuthResult = { ok: true } | { ok: false; reason: AuthFailure; message: string | null };

/**
 * Everything a screen renders about auth, as one immutable value.
 *
 * `ready` is the difference between "signed out" and "not looked yet": the stored session is
 * read asynchronously, so the first paint of a signed-in user's Account screen must show
 * neither a sign-in form nor a signed-in panel until this flips (N2 — never show a guess as
 * a fact). On a build with no client it flips immediately, because there is nothing to wait
 * for.
 */
export interface AuthSnapshot {
  readonly ready: boolean;
  readonly configured: boolean;
  readonly userId: string | null;
  /** The address a code was sent to, or the signed-in user's. */
  readonly email: string | null;
  readonly stage: AuthStage;
  /** Device clock (ms) of the last accepted send. The resend clock; not persisted. */
  readonly codeSentAt: number | null;
}

const SIGNED_OUT: AuthSnapshot = {
  ready: false,
  configured: false,
  userId: null,
  email: null,
  stage: "signed_out",
  codeSentAt: null,
};

let snapshot: AuthSnapshot = SIGNED_OUT;
const listeners = new Set<() => void>();
let started = false;
let unsubscribeClient: (() => void) | null = null;

function same(a: AuthSnapshot, b: AuthSnapshot): boolean {
  return (
    a.ready === b.ready &&
    a.configured === b.configured &&
    a.userId === b.userId &&
    a.email === b.email &&
    a.stage === b.stage &&
    a.codeSentAt === b.codeSentAt
  );
}

/**
 * The only writer. It replaces the snapshot object only when a field actually changed:
 * `useSyncExternalStore` compares snapshots by identity and re-renders on every new object,
 * so handing out a fresh copy per event would repaint the Account screen on each token
 * refresh — and a `getSnapshot` that never returns a stable value makes React throw.
 */
function setSnapshot(patch: Partial<AuthSnapshot>): void {
  const next: AuthSnapshot = { ...snapshot, ...patch };
  if (same(next, snapshot)) return;
  snapshot = next;
  // A copy: a listener that unsubscribes itself must not perturb the walk.
  for (const listener of [...listeners]) listener();
}

/** `getSupabase()` is allowed to fail; a session read is not allowed to take the app down. */
function safeClient(): SupabaseClient | null {
  try {
    return getSupabase();
  } catch {
    return null;
  }
}

function applySession(session: Session | null): void {
  const userId = session?.user?.id ?? null;
  if (userId === null) {
    // A code in flight survives a null session: `signInWithOtp` does not create one, and
    // the INITIAL_SESSION event can land after the code was sent.
    const pending = snapshot.stage === "code_sent";
    setSnapshot({
      ready: true,
      userId: null,
      stage: pending ? "code_sent" : "signed_out",
      email: pending ? snapshot.email : null,
      codeSentAt: pending ? snapshot.codeSentAt : null,
    });
    return;
  }
  setSnapshot({
    ready: true,
    userId,
    stage: "signed_in",
    email: session?.user?.email ?? snapshot.email,
    // The code has been spent; a signed-in user has nothing to resend.
    codeSentAt: null,
  });
}

/**
 * Reads the persisted session once at startup. supabase-js emits INITIAL_SESSION to the
 * listener below on its own, so this is a belt-and-braces path for a client that never
 * emits — and it must not overwrite a *newer* answer, hence the `ready` guard: a sign-out
 * that lands first would otherwise be undone by a stale read resolving second.
 */
async function readStoredSession(client: SupabaseClient): Promise<void> {
  try {
    const { data } = await client.auth.getSession();
    if (!snapshot.ready) applySession(data.session ?? null);
  } catch {
    setSnapshot({ ready: true });
  }
}

/**
 * Starts the one auth listener, at most once per tab.
 *
 * Deliberately *not* called by `getAuthSnapshot`: React calls that during render, and
 * building a network client while painting is both a side effect in render and the thing
 * N7 forbids on a first paint. `subscribeAuth` runs after the commit, which is where this
 * belongs. The listener is never torn down when the last consumer unsubscribes — it is one
 * cheap callback, and dropping it would throw away the cached user id that keeps
 * `getUserId()` from awaiting anything.
 */
function ensureListener(): void {
  if (started) return;
  started = true;

  const client = safeClient();
  if (client === null) {
    setSnapshot({ ready: true, configured: false });
    return;
  }
  setSnapshot({ configured: true });

  try {
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      // Only local state is touched here: supabase-js documents that calling back into the
      // client from this callback can deadlock.
      applySession(session);
    });
    unsubscribeClient = () => data.subscription.unsubscribe();
  } catch {
    // A client that cannot report auth changes still must not leave the UI on "checking…".
    setSnapshot({ ready: true });
  }
  void readStoredSession(client);
}

/** The current state, synchronously, with no side effect. Safe to call during render. */
export function getAuthSnapshot(): AuthSnapshot {
  return snapshot;
}

/**
 * Subscribe to every change of the snapshot — the `useSyncExternalStore` shape. Starts the
 * auth listener on first use.
 */
export function subscribeAuth(listener: () => void): () => void {
  // Started before the listener joins, not after: the first subscriber would otherwise be
  // notified of the `configured` and `ready` transitions its own call caused. React re-reads
  // the snapshot after subscribing, so nothing is missed by staying quiet here.
  ensureListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Contract export. Fires when the **user id** changes and only then: a token refresh or a
 * cooldown tick is not an auth change to a consumer that starts and stops syncing.
 *
 * It does not fire for the value the store already holds at subscribe time — read that with
 * `getUserId()`. It does fire for the first resolution of a persisted session (null → id),
 * so a consumer that subscribes at app start is woken by the sign-in it missed.
 */
export function onAuthChange(fn: (userId: string | null) => void): () => void {
  let delivered = snapshot.userId;
  return subscribeAuth(() => {
    if (snapshot.userId === delivered) return;
    delivered = snapshot.userId;
    fn(delivered);
  });
}

/**
 * Contract export. The signed-in user's id, or `null`.
 *
 * Once the listener has resolved, this answers from memory without awaiting anything, which
 * is what lets the sync engine call it per push without adding a round trip. Before that it
 * falls back to the persisted session. It never rejects: a caller on a write path must not
 * have to wrap it (N7).
 */
export async function getUserId(): Promise<string | null> {
  const client = safeClient();
  if (client === null) return null;
  ensureListener();
  if (snapshot.ready) return snapshot.userId;
  try {
    const { data } = await client.auth.getSession();
    return data.session?.user?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Seconds left before a resend is allowed (§9-S4), rounded up, `0` when one is.
 *
 * Clamped to the full window because the clock is the device's: a phone that picks up
 * network time mid-wait and moves *backwards* would otherwise measure a negative elapsed
 * time and hold the resend button hostage for as long as the correction was large.
 */
export function resendSecondsRemaining(now: number = Date.now()): number {
  const sentAt = snapshot.codeSentAt;
  if (sentAt === null) return 0;
  const remaining = Math.min(sentAt + RESEND_COOLDOWN_MS - now, RESEND_COOLDOWN_MS);
  return remaining <= 0 ? 0 : Math.ceil(remaining / 1000);
}

function fail(reason: AuthFailure, message: string | null): AuthResult {
  return { ok: false, reason, message };
}

function messageOf(error: unknown): string | null {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string" && error !== "") return error;
  return null;
}

/** A transport failure, not an answer: no signal, DNS gone, the request cut off. */
function isTransportFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AuthRetryableFetchError";
}

/**
 * Maps a Supabase error onto the distinction the screen needs. `phase` matters for one
 * case: GoTrue answers a wrong or expired code with a 4xx that does not always carry a
 * code, and on the verify step that is what "didn't match" looks like (§6.4).
 */
function classify(error: AuthError, phase: "send" | "verify"): AuthFailure {
  if (isTransportFailure(error) || error.status === 0) return "offline";
  const code = typeof error.code === "string" ? error.code : "";
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit") {
    return "rate_limited";
  }
  if (error.status === 429) return "rate_limited";
  if (code === "email_address_invalid") return "invalid_email";
  if (code === "otp_expired" || code === "invalid_credentials") return "invalid_code";
  if (
    phase === "verify" &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500
  ) {
    return "invalid_code";
  }
  return "unknown";
}

/**
 * Send a 6-digit code to `email` (§4.12: `signInWithOtp`, `shouldCreateUser: true` — there
 * is no separate sign-up in v1; the first code creates the account).
 *
 * The 30 s cooldown applies per address. Re-sending to the same address before it elapses
 * is refused here rather than at the server, which both honours §9-S4 and keeps the user
 * clear of GoTrue's own rate limit; typing a *different* address is a correction, not a
 * resend, so it goes straight through — a field user who mistyped their email should not
 * wait out a timer for a code that will never arrive.
 *
 * A failed send does not start the clock: there is nothing to wait for.
 */
export async function sendCode(email: string): Promise<AuthResult> {
  const address = email.trim();
  if (address === "") return fail("invalid_email", null);

  const client = safeClient();
  if (client === null) {
    setSnapshot({ ready: true, configured: false });
    return fail("not_configured", null);
  }
  ensureListener();

  if (address === snapshot.email && resendSecondsRemaining() > 0) return fail("cooldown", null);

  try {
    const { error } = await client.auth.signInWithOtp({
      email: address,
      options: { shouldCreateUser: true },
    });
    if (error) return fail(classify(error, "send"), messageOf(error));
  } catch (cause) {
    return fail(isTransportFailure(cause) ? "offline" : "unknown", messageOf(cause));
  }

  setSnapshot({ stage: "code_sent", email: address, codeSentAt: Date.now() });
  return { ok: true };
}

/**
 * Verify the code that was sent, for the address it was sent to (§4.12: `verifyOtp`,
 * `type: "email"`).
 *
 * The address is the module's, never the screen's: verifying against a different one than
 * the code was issued for fails at the server with a message that reads like a bad code.
 * Whitespace is stripped because a pasted code arrives with it; the length is *not* checked
 * — the token length is the Supabase project's setting, and a client that rejects anything
 * but six digits would silently break a project configured otherwise.
 *
 * On success the session is applied immediately rather than waiting for the SIGNED_IN
 * event, so the caller's next line already sees a user id.
 */
export async function verifyCode(token: string): Promise<AuthResult> {
  const code = token.replace(/\s+/g, "");
  if (code === "") return fail("invalid_code", null);

  const email = snapshot.email;
  if (snapshot.stage !== "code_sent" || email === null) return fail("no_pending_code", null);

  const client = safeClient();
  if (client === null) {
    setSnapshot({ ready: true, configured: false });
    return fail("not_configured", null);
  }
  ensureListener();

  try {
    const { data, error } = await client.auth.verifyOtp({ email, token: code, type: "email" });
    if (error) return fail(classify(error, "verify"), messageOf(error));
    applySession(data.session ?? null);
  } catch (cause) {
    return fail(isTransportFailure(cause) ? "offline" : "unknown", messageOf(cause));
  }

  // A 200 with no session is not a sign-in, whatever it is. Never report one (N2).
  if (snapshot.userId === null) return fail("unknown", null);
  return { ok: true };
}

/**
 * End the session. Local state is cleared first and unconditionally: signing out is a
 * decision the user has already made, and a phone with no signal must not be told it is
 * still signed in because the server could not be reached. supabase-js drops the persisted
 * session on its side for the same reason.
 *
 * This ends the *session* only. §9-S4's two sign-out choices — keep this phone's records,
 * or clear them — are Dexie decisions the Account screen and the sync engine make around
 * this call.
 */
export async function signOut(): Promise<AuthResult> {
  const client = safeClient();
  setSnapshot({ userId: null, email: null, stage: "signed_out", codeSentAt: null, ready: true });
  if (client === null) return { ok: true };

  try {
    const { error } = await client.auth.signOut();
    if (error) return fail(classify(error, "send"), messageOf(error));
  } catch (cause) {
    return fail(isTransportFailure(cause) ? "offline" : "unknown", messageOf(cause));
  }
  return { ok: true };
}

/**
 * Tests only. Module state is the point of this file, and it would otherwise leak from one
 * test into the next; the supabase listener has to go with it, or a stale fake client keeps
 * writing into the store.
 */
export function resetAuthForTests(): void {
  unsubscribeClient?.();
  unsubscribeClient = null;
  started = false;
  listeners.clear();
  snapshot = SIGNED_OUT;
}
