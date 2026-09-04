/**
 * The hook the Account screen renders (§6.2, §9-S4). It owns no auth state: everything
 * durable lives in `./session`, above React, so the resend cooldown survives a re-render,
 * a navigation away from the screen and back, and the Account screen unmounting entirely.
 *
 * What is component state here is only what belongs to one screen's lifetime — whether a
 * request this screen started is still in flight, and why the last one failed.
 *
 * First paint costs nothing: `getAuthSnapshot` is a synchronous read of a module constant
 * until something subscribes, and React subscribes after the commit. No session read, no
 * client construction, no network on the way to pixels (N7).
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  getAuthSnapshot,
  RESEND_COOLDOWN_MS,
  resendSecondsRemaining,
  sendCode,
  signOut,
  subscribeAuth,
  verifyCode,
} from "./session";
import type { AuthFailure, AuthResult, AuthSnapshot } from "./session";

/**
 * Twice a second, not once: the countdown is rendered as whole seconds, and a 1000 ms tick
 * that drifts against the send instant makes the last second visibly hang.
 */
export const TICK_MS = 500;

export interface AuthApi extends AuthSnapshot {
  /** §9-S4's 30 s, counting down; `0` when a resend is allowed. */
  readonly resendSeconds: number;
  readonly canResend: boolean;
  /** A request this screen started has not answered yet. */
  readonly busy: boolean;
  /** Why the last request failed, cleared when the next one starts. */
  readonly error: AuthFailure | null;
  readonly sendCode: (email: string) => Promise<AuthResult>;
  readonly verifyCode: (token: string) => Promise<AuthResult>;
  readonly signOut: () => Promise<AuthResult>;
}

/**
 * Drives `tick` with the current instant until the resend cooldown has elapsed, then stops
 * on its own — a countdown that has reached zero has nothing left to re-render.
 *
 * Extracted from the effect, with its guard, so the whole rule is testable in a runner with
 * no DOM: the effect below is one line of wiring around this.
 */
export function startResendTicker(
  codeSentAt: number | null,
  tick: (now: number) => void,
  intervalMs = TICK_MS,
): (() => void) | undefined {
  // Nothing sent, nothing counting down. A ticker started anyway would wake the screen twice
  // a second for as long as it stayed open.
  if (codeSentAt === null) return undefined;

  tick(Date.now());
  const timer = setInterval(() => {
    const at = Date.now();
    tick(at);
    if (resendSecondsRemaining(at) === 0) clearInterval(timer);
  }, intervalMs);
  return () => clearInterval(timer);
}

export function useAuth(): AuthApi {
  // The same reader for client and server snapshots: it is a plain module read, so there is
  // nothing for a first paint to get wrong and nothing to hydrate around.
  const snapshot = useSyncExternalStore(subscribeAuth, getAuthSnapshot, getAuthSnapshot);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthFailure | null>(null);

  const { codeSentAt } = snapshot;
  useEffect(() => startResendTicker(codeSentAt, setNow), [codeSentAt]);

  const run = useCallback(async (action: () => Promise<AuthResult>): Promise<AuthResult> => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (!result.ok) setError(result.reason);
      return result;
    } finally {
      setBusy(false);
    }
  }, []);

  const send = useCallback((email: string) => run(() => sendCode(email)), [run]);
  const verify = useCallback((token: string) => run(() => verifyCode(token)), [run]);
  const out = useCallback(() => run(() => signOut()), [run]);

  const resendSeconds = resendSecondsRemaining(now);
  return {
    ...snapshot,
    resendSeconds,
    // Nothing to resend is not the same as being allowed to resend, and the sign-in screen
    // shows the button only once a code is out.
    canResend: codeSentAt !== null && resendSeconds === 0,
    busy,
    error,
    sendCode: send,
    verifyCode: verify,
    signOut: out,
  };
}

/** Re-exported so a screen can label the wait without importing two modules. */
export { RESEND_COOLDOWN_MS };
