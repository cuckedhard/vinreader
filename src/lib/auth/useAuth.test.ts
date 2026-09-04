/**
 * What can be pinned about a hook in a test runner with no DOM, and what cannot.
 *
 * `vitest.config.ts` runs the `node` environment, so there is no browser to mount into and
 * `useEffect` never fires. That still leaves the two things most likely to be wrong here:
 *
 *  - **the first paint**, which is rendered on the server exactly as it is in the browser —
 *    a synchronous read of module state, before anything subscribes. This is where N7 bites:
 *    an Account screen that built a Supabase client or read a session on its way to pixels
 *    would be doing network work during a render.
 *  - **the countdown**, extracted out of the effect into `startResendTicker` precisely so a
 *    node runner can drive it.
 *
 * Left to `tests/e2e/`: that a mounted screen re-renders as the countdown falls, that `busy`
 * flips around a request, and that the subscription tears down on unmount. Those need a DOM,
 * and the environment is a `package.json` decision this slice does not own.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

const supabase = vi.hoisted(() => ({
  client: null as SupabaseClient | null,
  calls: 0,
}));

vi.mock("./client", () => ({
  getSupabase: () => {
    supabase.calls += 1;
    return supabase.client;
  },
}));

const { getAuthSnapshot, resetAuthForTests, sendCode, subscribeAuth, RESEND_COOLDOWN_MS } =
  await import("./session");
const { startResendTicker, useAuth } = await import("./useAuth");
type AuthApi = ReturnType<typeof useAuth>;

const EMAIL = "zach@example.com";
const USER_ID = "8f14e45f-ceea-467a-9b2e-3f4b1c2d0e01";
const EPOCH = Date.UTC(2026, 8, 4, 12, 0, 0);

interface FakeClient {
  client: SupabaseClient;
  emit: (session: Session | null) => void;
  signInWithOtp: Mock;
  verifyOtp: Mock;
  signOut: Mock;
}

function makeClient(): FakeClient {
  const callbacks: ((event: string, session: Session | null) => void)[] = [];
  const signInWithOtp = vi.fn().mockResolvedValue({ data: {}, error: null });
  const verifyOtp = vi.fn().mockResolvedValue({
    data: { session: { user: { id: USER_ID, email: EMAIL } } as unknown as Session },
    error: null,
  });
  const signOut = vi.fn().mockResolvedValue({ error: null });
  const auth = {
    onAuthStateChange: (callback: (event: string, session: Session | null) => void) => {
      callbacks.push(callback);
      return { data: { subscription: { unsubscribe: () => {} } } };
    },
    getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    signInWithOtp,
    verifyOtp,
    signOut,
  };
  return {
    client: { auth } as unknown as SupabaseClient,
    emit: (session) => callbacks.forEach((callback) => callback("SIGNED_IN", session)),
    signInWithOtp,
    verifyOtp,
    signOut,
  };
}

/**
 * One paint of a component that uses the hook, with the API it was handed. This is a real
 * React render — the hook rules apply — and it runs the render phase only, which is exactly
 * the phase N7 cares about.
 */
function paint(): { api: AuthApi; html: string } {
  let api: AuthApi | null = null;
  function Probe() {
    api = useAuth();
    return createElement("output", null, `${api.stage}:${api.userId ?? "-"}:${api.resendSeconds}`);
  }
  const html = renderToStaticMarkup(createElement(Probe));
  if (api === null) throw new Error("the probe never rendered");
  return { api, html };
}

beforeEach(() => {
  supabase.client = null;
  supabase.calls = 0;
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH);
});

afterEach(() => {
  vi.useRealTimers();
  resetAuthForTests();
});

describe("the first paint", () => {
  it("renders signed out, with nothing pending and nothing to wait for", () => {
    const { api, html } = paint();

    expect(api).toMatchObject({
      ready: false,
      configured: false,
      userId: null,
      email: null,
      stage: "signed_out",
      codeSentAt: null,
      resendSeconds: 0,
      canResend: false,
      busy: false,
      error: null,
    });
    expect(html).toBe("<output>signed_out:-:0</output>");
  });

  it("touches no Supabase client on the way to pixels (N7)", () => {
    supabase.client = makeClient().client;

    paint();

    // The listener starts in `subscribeAuth`, which React calls after the commit. A render
    // that constructed a client would be doing network setup inside a paint, on a screen the
    // user may have opened with no signal.
    expect(supabase.calls).toBe(0);
  });

  it("renders the same for a build that has no Supabase at all", () => {
    // The unconfigured build, which is what most users run (§7 item 2). Nothing throws,
    // nothing is undefined, and the Account screen has a state to draw.
    expect(() => paint()).not.toThrow();
    expect(paint().api.configured).toBe(false);
  });
});

describe("what a later paint shows", () => {
  it("shows the signed-in user once the session has resolved", () => {
    const fake = makeClient();
    supabase.client = fake.client;
    paint();
    // A server render never subscribes, so this stands in for the commit that follows the
    // first paint in the browser; then the store learns what it was waiting for.
    subscribeAuth(() => {});
    fake.emit({ user: { id: USER_ID, email: EMAIL } } as unknown as Session);

    const { api, html } = paint();

    expect(api).toMatchObject({ ready: true, userId: USER_ID, email: EMAIL, stage: "signed_in" });
    expect(html).toContain(`signed_in:${USER_ID}`);
  });

  it("renders the resend cooldown and forbids a resend inside it", async () => {
    supabase.client = makeClient().client;
    await sendCode(EMAIL);

    expect(paint().api).toMatchObject({ stage: "code_sent", resendSeconds: 30, canResend: false });

    vi.setSystemTime(EPOCH + RESEND_COOLDOWN_MS);
    expect(paint().api).toMatchObject({ resendSeconds: 0, canResend: true });
  });

  it("does not offer a resend when no code is out", () => {
    // `canResend` is not "the cooldown has elapsed" — before any send there is nothing to
    // send again, and the sign-in screen shows the button only once a code is out.
    expect(paint().api).toMatchObject({ resendSeconds: 0, canResend: false });
  });

  it("keeps the countdown across a re-render, because the clock is not in the component", async () => {
    supabase.client = makeClient().client;
    await sendCode(EMAIL);
    vi.setSystemTime(EPOCH + 12_000);

    // Every `paint()` is a fresh component with fresh state. A cooldown held in `useState`
    // would restart at 30 here, every time the screen re-rendered or was navigated back to.
    expect(paint().api.resendSeconds).toBe(18);
    expect(paint().api.resendSeconds).toBe(18);
  });
});

describe("the three actions", () => {
  it("sends a code through the session module", async () => {
    const fake = makeClient();
    supabase.client = fake.client;

    await expect(paint().api.sendCode(` ${EMAIL} `)).resolves.toEqual({ ok: true });

    expect(fake.signInWithOtp).toHaveBeenCalledWith({
      email: EMAIL,
      options: { shouldCreateUser: true },
    });
    expect(getAuthSnapshot().stage).toBe("code_sent");
  });

  it("verifies a code through the session module", async () => {
    const fake = makeClient();
    supabase.client = fake.client;
    await paint().api.sendCode(EMAIL);

    await expect(paint().api.verifyCode("123456")).resolves.toEqual({ ok: true });

    expect(fake.verifyOtp).toHaveBeenCalledWith({
      email: EMAIL,
      token: "123456",
      type: "email",
    });
    expect(paint().api.userId).toBe(USER_ID);
  });

  it("signs out through the session module", async () => {
    const fake = makeClient();
    supabase.client = fake.client;
    await paint().api.sendCode(EMAIL);
    await paint().api.verifyCode("123456");

    await expect(paint().api.signOut()).resolves.toEqual({ ok: true });

    expect(fake.signOut).toHaveBeenCalled();
    expect(paint().api).toMatchObject({ userId: null, stage: "signed_out" });
  });

  it("returns the failure rather than throwing it at the screen", async () => {
    // No client: the unconfigured build again. The screen gets a reason it can put words to
    // (§6.4), not a rejected promise it has to catch.
    await expect(paint().api.sendCode(EMAIL)).resolves.toEqual({
      ok: false,
      reason: "not_configured",
      message: null,
    });
  });
});

describe("startResendTicker — the countdown, without React", () => {
  it("starts nothing when no code is out", () => {
    const tick = vi.fn();

    expect(startResendTicker(null, tick)).toBeUndefined();
    vi.advanceTimersByTime(RESEND_COOLDOWN_MS);

    // Most of the Account screen's life is this case — signed in, or signed out with no code
    // in flight. A timer here would wake it twice a second for as long as it stayed open.
    expect(tick).not.toHaveBeenCalled();
  });

  it("reports the current instant immediately and then on every tick", async () => {
    supabase.client = makeClient().client;
    await sendCode(EMAIL);
    const seen: number[] = [];

    const stop = startResendTicker(EPOCH, (now) => seen.push(now), 1_000);

    // The first report is synchronous: the screen must not show a stale second while it
    // waits for the first interval.
    expect(seen).toEqual([EPOCH]);
    vi.advanceTimersByTime(2_000);
    expect(seen).toEqual([EPOCH, EPOCH + 1_000, EPOCH + 2_000]);
    stop?.();
  });

  it("stops itself when the cooldown reaches zero", async () => {
    supabase.client = makeClient().client;
    await sendCode(EMAIL);
    const seen: number[] = [];

    startResendTicker(EPOCH, (now) => seen.push(now), 10_000);
    vi.advanceTimersByTime(RESEND_COOLDOWN_MS);
    const atZero = seen.length;
    vi.advanceTimersByTime(RESEND_COOLDOWN_MS * 10);

    // A countdown that has finished has nothing left to re-render. Left running, it would
    // wake the Account screen twice a second for as long as it stayed open.
    expect(seen.at(-1)).toBe(EPOCH + RESEND_COOLDOWN_MS);
    expect(seen.length).toBe(atZero);
  });

  it("stops when the caller tears it down mid-countdown", async () => {
    supabase.client = makeClient().client;
    await sendCode(EMAIL);
    const seen: number[] = [];

    const stop = startResendTicker(EPOCH, (now) => seen.push(now), 1_000);
    vi.advanceTimersByTime(1_000);
    stop?.();
    vi.advanceTimersByTime(10_000);

    // The unmount path: the effect's cleanup. Without it, a screen the user has left keeps a
    // timer alive that calls `setState` on a component that is gone.
    expect(seen).toEqual([EPOCH, EPOCH + 1_000]);
  });
});
