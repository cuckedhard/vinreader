/**
 * The sign-in state machine: send → verify → session, plus the two rules that outlive any
 * screen (the 30 s resend clock, and who is signed in).
 *
 * Every test here drives a fake supabase client, because the three things worth pinning are
 * things a real one would hide: what is sent, what is *not* sent, and what happens when the
 * call never lands. `useAuth.test.ts` covers the React binding; nothing in either file
 * touches the network.
 */
import { AuthApiError, AuthError, AuthRetryableFetchError } from "@supabase/supabase-js";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

const supabase = vi.hoisted(() => ({
  /** What `getSupabase()` hands back. `null` is the unconfigured build. */
  client: null as SupabaseClient | null,
  /** A `getSupabase()` that throws — the case every caller of it must survive. */
  throws: false,
  calls: 0,
}));

vi.mock("./client", () => ({
  getSupabase: () => {
    supabase.calls += 1;
    if (supabase.throws) throw new Error("client construction blew up");
    return supabase.client;
  },
}));

const {
  getAuthSnapshot,
  getUserId,
  onAuthChange,
  RESEND_COOLDOWN_MS,
  resendSecondsRemaining,
  resetAuthForTests,
  sendCode,
  signOut,
  subscribeAuth,
  verifyCode,
} = await import("./session");

const EMAIL = "zach@example.com";
const OTHER_EMAIL = "desk@example.com";
const CODE = "123456";
const USER_ID = "8f14e45f-ceea-467a-9b2e-3f4b1c2d0e01";
const EPOCH = Date.UTC(2026, 8, 4, 12, 0, 0);

type AuthCallback = (event: string, session: Session | null) => void;

interface FakeClient {
  client: SupabaseClient;
  /** Push an auth event, the way supabase-js does after a sign-in or a token refresh. */
  emit: (session: Session | null) => void;
  signInWithOtp: Mock;
  verifyOtp: Mock;
  getSession: Mock;
  signOut: Mock;
  unsubscribed: () => number;
}

function sessionFor(userId: string, email: string | null = EMAIL): Session {
  return { user: { id: userId, email: email ?? undefined } } as unknown as Session;
}

/** A client that answers everything successfully unless a test says otherwise. */
function makeClient(stored: Session | null = null): FakeClient {
  const callbacks: AuthCallback[] = [];
  let unsubscribes = 0;
  const signInWithOtp = vi.fn().mockResolvedValue({ data: {}, error: null });
  const verifyOtp = vi
    .fn()
    .mockImplementation(async () => ({ data: { session: sessionFor(USER_ID) }, error: null }));
  const getSession = vi.fn().mockImplementation(async () => ({
    data: { session: stored },
    error: null,
  }));
  const signOutFn = vi.fn().mockResolvedValue({ error: null });

  const auth = {
    onAuthStateChange: (callback: AuthCallback) => {
      callbacks.push(callback);
      return {
        data: {
          subscription: {
            unsubscribe: () => {
              unsubscribes += 1;
            },
          },
        },
      };
    },
    getSession,
    signInWithOtp,
    verifyOtp,
    signOut: signOutFn,
  };

  return {
    client: { auth } as unknown as SupabaseClient,
    emit: (session) => callbacks.forEach((callback) => callback("SIGNED_IN", session)),
    signInWithOtp,
    verifyOtp,
    getSession,
    signOut: signOutFn,
    unsubscribed: () => unsubscribes,
  };
}

/** Installs a fake client and starts the listener, the way a mounted screen would. */
function install(stored: Session | null = null): FakeClient {
  const fake = makeClient(stored);
  supabase.client = fake.client;
  return fake;
}

/** Sends a code and returns the fake, leaving the module in `code_sent`. */
async function withCodeSent(): Promise<FakeClient> {
  const fake = install();
  await sendCode(EMAIL);
  return fake;
}

beforeEach(() => {
  supabase.client = null;
  supabase.throws = false;
  supabase.calls = 0;
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH);
});

afterEach(() => {
  vi.useRealTimers();
  resetAuthForTests();
});

describe("the snapshot before anything happens", () => {
  it("is signed out, not ready, and costs no client", () => {
    // The Account screen's first paint. `ready: false` is what keeps it from rendering a
    // sign-in form at a user who is signed in (N2), and no client is built to find out.
    expect(getAuthSnapshot()).toEqual({
      ready: false,
      configured: false,
      userId: null,
      email: null,
      stage: "signed_out",
      codeSentAt: null,
    });
    expect(supabase.calls).toBe(0);
  });

  it("stays that way however many times it is read", () => {
    // `useSyncExternalStore` throws if `getSnapshot` returns a new object per call.
    expect(getAuthSnapshot()).toBe(getAuthSnapshot());
  });
});

describe("starting the listener", () => {
  it("is what subscribing does, and it happens once however many subscribers there are", () => {
    const fake = install();
    const first = vi.fn();
    const second = vi.fn();

    const stopFirst = subscribeAuth(first);
    const stopSecond = subscribeAuth(second);
    fake.emit(sessionFor(USER_ID));

    expect(supabase.calls).toBe(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    stopFirst();
    stopSecond();
  });

  it("notifies only when a field actually changed", () => {
    const fake = install();
    const listener = vi.fn();
    subscribeAuth(listener);

    fake.emit(sessionFor(USER_ID));
    fake.emit(sessionFor(USER_ID));
    fake.emit(sessionFor(USER_ID));

    // Token refreshes emit the same user over and over. Repainting the Account screen on
    // each one is the difference between a snapshot and a stream.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops notifying an unsubscribed listener", () => {
    const fake = install();
    const listener = vi.fn();
    subscribeAuth(listener)();

    fake.emit(sessionFor(USER_ID));

    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps the supabase subscription when the last screen goes away", () => {
    const fake = install();
    const stop = subscribeAuth(vi.fn());

    stop();
    fake.emit(sessionFor(USER_ID));

    // One listener per tab, kept for its lifetime. Dropping it with the last screen would
    // throw away the cached user id that keeps `getUserId()` from awaiting a session read on
    // every push, and the store would go stale while the sync engine still ran.
    expect(fake.unsubscribed()).toBe(0);
    expect(getAuthSnapshot().userId).toBe(USER_ID);
  });

  it("marks an unconfigured build ready immediately, with nothing to wait for", () => {
    subscribeAuth(vi.fn());

    expect(getAuthSnapshot().ready).toBe(true);
    expect(getAuthSnapshot().configured).toBe(false);
  });

  it("survives a getSupabase() that throws", () => {
    supabase.throws = true;

    expect(() => subscribeAuth(vi.fn())).not.toThrow();
    expect(getAuthSnapshot()).toMatchObject({ ready: true, configured: false, userId: null });
  });

  it("survives a client that cannot register a listener", async () => {
    const fake = install();
    const auth = fake.client.auth as unknown as { onAuthStateChange: () => never };
    auth.onAuthStateChange = () => {
      throw new Error("no listener for you");
    };

    expect(() => subscribeAuth(vi.fn())).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    // Not left on "checking…" forever, which is what a screen renders while `ready` is false.
    expect(getAuthSnapshot().ready).toBe(true);
  });

  it("reads the stored session for a client that never emits", async () => {
    const fake = install(sessionFor(USER_ID));
    const auth = fake.client.auth as unknown as { onAuthStateChange: () => unknown };
    auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe: () => {} } } });

    subscribeAuth(vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    expect(getAuthSnapshot()).toMatchObject({ ready: true, userId: USER_ID, stage: "signed_in" });
  });

  it("lets a signed-out event win over a stored session that resolves later", async () => {
    const slow = { release: () => {} };
    const fake = install();
    fake.getSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          slow.release = () => resolve({ data: { session: sessionFor(USER_ID) }, error: null });
        }),
    );

    subscribeAuth(vi.fn());
    fake.emit(null); // SIGNED_OUT lands first
    slow.release();
    await vi.advanceTimersByTimeAsync(0);

    // The slower read must not resurrect a session the user has already ended.
    expect(getAuthSnapshot().userId).toBeNull();
  });

  it("survives a getSession() that rejects", async () => {
    const fake = install();
    const auth = fake.client.auth as unknown as { onAuthStateChange: () => unknown };
    auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe: () => {} } } });
    fake.getSession.mockRejectedValue(new Error("storage is gone"));

    subscribeAuth(vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    expect(getAuthSnapshot().ready).toBe(true);
  });
});

describe("getUserId — the contract the sync engine imports", () => {
  it("is null on an unconfigured build, without throwing", async () => {
    await expect(getUserId()).resolves.toBeNull();
  });

  it("is null when getSupabase() throws", async () => {
    supabase.throws = true;

    await expect(getUserId()).resolves.toBeNull();
  });

  it("falls back to the persisted session before the listener has resolved", async () => {
    const fake = install(sessionFor(USER_ID));

    await expect(getUserId()).resolves.toBe(USER_ID);
    expect(fake.getSession).toHaveBeenCalled();
  });

  it("answers from memory once the listener has resolved", async () => {
    const fake = install();
    subscribeAuth(vi.fn());
    fake.emit(sessionFor(USER_ID));
    const before = fake.getSession.mock.calls.length;

    await expect(getUserId()).resolves.toBe(USER_ID);
    await expect(getUserId()).resolves.toBe(USER_ID);

    // §4.12 pushes in batches and asks who is signed in each time. That must not be a round
    // trip, or every push waits on storage and, when the token is stale, on the network.
    expect(fake.getSession.mock.calls.length).toBe(before);
  });

  it("is null rather than a rejection when the session read fails", async () => {
    const fake = install();
    fake.getSession.mockRejectedValue(new AuthError("network gone", 0));

    await expect(getUserId()).resolves.toBeNull();
  });

  it("is null for a session with no user", async () => {
    const fake = install();
    fake.getSession.mockResolvedValue({ data: { session: null }, error: null });

    await expect(getUserId()).resolves.toBeNull();
  });
});

describe("onAuthChange — the other contract export", () => {
  it("fires on the change and carries the new id", () => {
    const fake = install();
    const seen: (string | null)[] = [];
    onAuthChange((userId) => seen.push(userId));

    fake.emit(sessionFor(USER_ID));
    fake.emit(null);

    expect(seen).toEqual([USER_ID, null]);
  });

  it("does not fire for the id the caller could already read", () => {
    const fake = install();
    subscribeAuth(vi.fn());
    fake.emit(sessionFor(USER_ID));

    const listener = vi.fn();
    onAuthChange(listener);
    fake.emit(sessionFor(USER_ID));

    expect(listener).not.toHaveBeenCalled();
  });

  it("ignores snapshot changes that are not a change of user", async () => {
    install();
    const listener = vi.fn();
    onAuthChange(listener);

    await sendCode(EMAIL);

    // Sending a code moves `stage` and starts the resend clock. To a consumer that starts
    // and stops syncing, that is not an auth change.
    expect(getAuthSnapshot().stage).toBe("code_sent");
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops on unsubscribe", () => {
    const fake = install();
    const listener = vi.fn();
    onAuthChange(listener)();

    fake.emit(sessionFor(USER_ID));

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("sendCode", () => {
  it("asks for a code for the address, creating the account if it is new", async () => {
    const fake = install();

    await expect(sendCode(EMAIL)).resolves.toEqual({ ok: true });

    // §4.12: `signInWithOtp` with `shouldCreateUser: true`. There is no separate sign-up.
    expect(fake.signInWithOtp).toHaveBeenCalledWith({
      email: EMAIL,
      options: { shouldCreateUser: true },
    });
    expect(getAuthSnapshot()).toMatchObject({
      stage: "code_sent",
      email: EMAIL,
      codeSentAt: EPOCH,
    });
  });

  it("trims the address a phone keyboard padded", async () => {
    const fake = install();

    await sendCode(`  ${EMAIL} `);

    expect(fake.signInWithOtp).toHaveBeenCalledWith({
      email: EMAIL,
      options: { shouldCreateUser: true },
    });
    expect(getAuthSnapshot().email).toBe(EMAIL);
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
  ])("refuses an %s address without spending a request", async (_label, address) => {
    const fake = install();

    await expect(sendCode(address)).resolves.toEqual({
      ok: false,
      reason: "invalid_email",
      message: null,
    });
    expect(fake.signInWithOtp).not.toHaveBeenCalled();
  });

  it("reports a build with no Supabase rather than pretending a code is coming", async () => {
    await expect(sendCode(EMAIL)).resolves.toEqual({
      ok: false,
      reason: "not_configured",
      message: null,
    });
    expect(getAuthSnapshot().stage).toBe("signed_out");
  });

  it("reports a getSupabase() that throws the same way", async () => {
    supabase.throws = true;

    await expect(sendCode(EMAIL)).resolves.toMatchObject({ reason: "not_configured" });
  });
});

describe("the 30 s resend cooldown (§9-S4)", () => {
  it("counts down whole seconds and reaches zero exactly at the window", async () => {
    await withCodeSent();

    expect(resendSecondsRemaining()).toBe(30);
    vi.setSystemTime(EPOCH + 1);
    expect(resendSecondsRemaining()).toBe(30);
    vi.setSystemTime(EPOCH + 29_500);
    expect(resendSecondsRemaining()).toBe(1);
    vi.setSystemTime(EPOCH + RESEND_COOLDOWN_MS);
    expect(resendSecondsRemaining()).toBe(0);
  });

  it("is zero when no code is out", () => {
    expect(resendSecondsRemaining()).toBe(0);
  });

  it("refuses a resend to the same address, without spending a request", async () => {
    const fake = install();
    await sendCode(EMAIL);
    vi.setSystemTime(EPOCH + 29_999);

    await expect(sendCode(EMAIL)).resolves.toEqual({
      ok: false,
      reason: "cooldown",
      message: null,
    });
    expect(fake.signInWithOtp).toHaveBeenCalledTimes(1);
  });

  it("allows the resend once the window has passed, and restarts the clock", async () => {
    const fake = install();
    await sendCode(EMAIL);
    vi.setSystemTime(EPOCH + RESEND_COOLDOWN_MS);

    await expect(sendCode(EMAIL)).resolves.toEqual({ ok: true });

    expect(fake.signInWithOtp).toHaveBeenCalledTimes(2);
    expect(resendSecondsRemaining()).toBe(30);
  });

  it("lets a corrected address through immediately", async () => {
    const fake = install();
    await sendCode(EMAIL);
    vi.setSystemTime(EPOCH + 2_000);

    await expect(sendCode(OTHER_EMAIL)).resolves.toEqual({ ok: true });

    // Someone who mistyped their email is not resending — they are sending for the first
    // time, to an address that can actually receive it.
    expect(fake.signInWithOtp).toHaveBeenCalledTimes(2);
    expect(getAuthSnapshot().email).toBe(OTHER_EMAIL);
  });

  it("does not start the clock on a send that failed", async () => {
    const fake = install();
    fake.signInWithOtp.mockResolvedValue({
      data: {},
      error: new AuthRetryableFetchError("no signal", 0),
    });

    await expect(sendCode(EMAIL)).resolves.toMatchObject({ reason: "offline" });

    // Nothing was sent, so there is nothing to wait for: the retry is immediate.
    expect(resendSecondsRemaining()).toBe(0);
    expect(getAuthSnapshot().stage).toBe("signed_out");
  });

  it("survives the device clock being corrected backwards mid-wait", async () => {
    await withCodeSent();
    vi.setSystemTime(EPOCH - 60 * 60 * 1000);

    // Unclamped this is 3630 seconds — a resend button held hostage for an hour because the
    // phone picked up network time.
    expect(resendSecondsRemaining()).toBe(30);
  });

  it("is module state, so it outlives the screen that started it", async () => {
    await withCodeSent();
    const stop = subscribeAuth(vi.fn());
    vi.setSystemTime(EPOCH + 10_000);

    stop(); // the Account screen unmounts
    subscribeAuth(vi.fn()); // and the user navigates back to it

    expect(resendSecondsRemaining()).toBe(20);
    expect(getAuthSnapshot().stage).toBe("code_sent");
  });
});

describe("verifyCode", () => {
  it("verifies the code against the address it was sent to", async () => {
    const fake = await withCodeSent();

    await expect(verifyCode(CODE)).resolves.toEqual({ ok: true });

    expect(fake.verifyOtp).toHaveBeenCalledWith({ email: EMAIL, token: CODE, type: "email" });
    expect(getAuthSnapshot()).toMatchObject({
      stage: "signed_in",
      userId: USER_ID,
      email: EMAIL,
      codeSentAt: null,
      ready: true,
    });
  });

  it("strips the whitespace a pasted code arrives with", async () => {
    const fake = await withCodeSent();

    await verifyCode(" 123 456\n");

    expect(fake.verifyOtp).toHaveBeenCalledWith({ email: EMAIL, token: CODE, type: "email" });
  });

  it("does not judge the code's length, which is the project's setting", async () => {
    const fake = await withCodeSent();

    await verifyCode("12345678");

    // A client that insisted on six digits would silently break a project configured for
    // any other length, and the failure would look like a wrong code.
    expect(fake.verifyOtp).toHaveBeenCalledWith({
      email: EMAIL,
      token: "12345678",
      type: "email",
    });
  });

  it("refuses when no code is out", async () => {
    const fake = install();

    await expect(verifyCode(CODE)).resolves.toEqual({
      ok: false,
      reason: "no_pending_code",
      message: null,
    });
    expect(fake.verifyOtp).not.toHaveBeenCalled();
  });

  it("refuses an empty code without spending a request", async () => {
    const fake = await withCodeSent();

    await expect(verifyCode("   ")).resolves.toMatchObject({ reason: "invalid_code" });
    expect(fake.verifyOtp).not.toHaveBeenCalled();
  });

  it("keeps the pending code after a wrong one, so the user can try again", async () => {
    const fake = await withCodeSent();
    fake.verifyOtp.mockResolvedValue({
      data: { session: null },
      error: new AuthApiError("Token has expired or is invalid", 403, undefined),
    });

    await expect(verifyCode("000000")).resolves.toMatchObject({ reason: "invalid_code" });

    // §6.4: "That code didn't match. Try again or resend." Both are still possible.
    expect(getAuthSnapshot()).toMatchObject({ stage: "code_sent", email: EMAIL });
    expect(resendSecondsRemaining()).toBe(30);
  });

  it("never reports a sign-in it did not get (N2)", async () => {
    const fake = await withCodeSent();
    fake.verifyOtp.mockResolvedValue({ data: { session: null }, error: null });

    await expect(verifyCode(CODE)).resolves.toEqual({
      ok: false,
      reason: "unknown",
      message: null,
    });
    expect(getAuthSnapshot().userId).toBeNull();
    expect(getAuthSnapshot().stage).toBe("code_sent");
  });

  it("reports a build with no Supabase", async () => {
    await withCodeSent();
    supabase.client = null;

    await expect(verifyCode(CODE)).resolves.toMatchObject({ reason: "not_configured" });
  });

  it("keeps the address from the session when the account has one", async () => {
    const fake = await withCodeSent();
    fake.verifyOtp.mockResolvedValue({
      data: { session: sessionFor(USER_ID, null) },
      error: null,
    });

    await verifyCode(CODE);

    // The session for a brand-new account can come back without an email; the address the
    // code went to is the one the Account screen has to show.
    expect(getAuthSnapshot().email).toBe(EMAIL);
  });
});

describe("classifying what the server said", () => {
  const cases: [string, AuthError, string][] = [
    [
      "a send rate limit",
      new AuthApiError("too many", 429, "over_email_send_rate_limit"),
      "rate_limited",
    ],
    [
      "a request rate limit",
      new AuthApiError("slow down", 400, "over_request_rate_limit"),
      "rate_limited",
    ],
    ["a bare 429", new AuthApiError("too many", 429, undefined), "rate_limited"],
    [
      "a rejected address",
      new AuthApiError("bad email", 400, "email_address_invalid"),
      "invalid_email",
    ],
    ["an expired code", new AuthApiError("expired", 403, "otp_expired"), "invalid_code"],
    ["bad credentials", new AuthApiError("nope", 400, "invalid_credentials"), "invalid_code"],
    ["a dropped request", new AuthRetryableFetchError("failed to fetch", 0), "offline"],
    ["a server fault", new AuthApiError("boom", 500, "unexpected_failure"), "unknown"],
    ["an error with no status at all", new AuthError("mystery"), "unknown"],
  ];

  it.each(cases)("maps %s on the send step", async (_label, error, reason) => {
    const fake = install();
    fake.signInWithOtp.mockResolvedValue({ data: {}, error });

    await expect(sendCode(EMAIL)).resolves.toMatchObject({ reason, message: error.message });
  });

  it("reads an unlabelled 4xx on the verify step as a code that did not match", async () => {
    const fake = await withCodeSent();
    fake.verifyOtp.mockResolvedValue({ data: {}, error: new AuthApiError("nope", 400, undefined) });

    // GoTrue does not always attach a code, and on this step there is only one thing a 4xx
    // can mean to the person holding the phone.
    await expect(verifyCode(CODE)).resolves.toMatchObject({ reason: "invalid_code" });
  });

  it("does not read a server fault on the verify step as a bad code", async () => {
    const fake = await withCodeSent();
    fake.verifyOtp.mockResolvedValue({ data: {}, error: new AuthApiError("boom", 500, undefined) });

    await expect(verifyCode(CODE)).resolves.toMatchObject({ reason: "unknown" });
  });

  it.each([
    ["a thrown fetch failure", new TypeError("Failed to fetch"), "offline", "Failed to fetch"],
    [
      "a thrown error with no message",
      Object.assign(new Error(""), { name: "Weird" }),
      "unknown",
      "Weird",
    ],
    ["a thrown string", "socket vanished", "unknown", "socket vanished"],
    ["a thrown nothing", null, "unknown", null],
  ])("survives %s from the client itself", async (_label, thrown, reason, message) => {
    const fake = install();
    fake.signInWithOtp.mockRejectedValue(thrown);

    await expect(sendCode(EMAIL)).resolves.toEqual({ ok: false, reason, message });
  });

  it("survives a throw from verifyOtp", async () => {
    const fake = await withCodeSent();
    fake.verifyOtp.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(verifyCode(CODE)).resolves.toMatchObject({ reason: "offline" });
    expect(getAuthSnapshot().stage).toBe("code_sent");
  });
});

describe("signOut", () => {
  it("ends the session and clears everything about it", async () => {
    const fake = await withCodeSent();
    await verifyCode(CODE);

    await expect(signOut()).resolves.toEqual({ ok: true });

    expect(fake.signOut).toHaveBeenCalled();
    expect(getAuthSnapshot()).toMatchObject({
      userId: null,
      email: null,
      stage: "signed_out",
      codeSentAt: null,
      ready: true,
    });
  });

  it("signs out locally even when the request fails", async () => {
    const fake = await withCodeSent();
    await verifyCode(CODE);
    fake.signOut.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(signOut()).resolves.toMatchObject({ reason: "offline" });

    // Signing out is a decision already made. A phone with no signal must not be told it is
    // still signed in.
    expect(getAuthSnapshot().userId).toBeNull();
  });

  it("reports an error the server returned, having still signed out locally", async () => {
    const fake = await withCodeSent();
    await verifyCode(CODE);
    fake.signOut.mockResolvedValue({ error: new AuthApiError("boom", 500, undefined) });

    await expect(signOut()).resolves.toMatchObject({ reason: "unknown" });
    expect(getAuthSnapshot().userId).toBeNull();
  });

  it("succeeds on a build with no Supabase, because there is no session to end", async () => {
    await expect(signOut()).resolves.toEqual({ ok: true });
  });
});

describe("N7 — none of this may reach the scan path", () => {
  it("keeps auth and supabase out of the storage layer's import graph", () => {
    // The rule that a test can actually hold: a write path that cannot import a session
    // cannot await one. §5.7's outbox is fed inside each write's transaction from data
    // already in hand, and this is what stops that from quietly acquiring a dependency.
    const storage = [
      "db.ts",
      "upsert.ts",
      "outbox.ts",
      "syncState.ts",
      "settings.ts",
      "decodeQueue.ts",
      "normalize.ts",
    ];

    for (const file of storage) {
      const source = readFileSync(new URL(`../storage/${file}`, import.meta.url), "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
      expect({ file, imports: imports.filter((name) => /supabase|auth/.test(name)) }).toEqual({
        file,
        imports: [],
      });
    }
  });

  it("saves a scan while getSupabase() throws on every call", async () => {
    vi.useRealTimers(); // IndexedDB runs on the event loop, and this test really writes
    supabase.throws = true;
    const { db } = await import("../storage/db");
    const { upsertVehicle } = await import("../storage/upsert");
    await db.open();
    await Promise.all(db.tables.map((table) => table.clear()));

    const record = await upsertVehicle({
      vin: "1HGCM82633A004352",
      origin: "scan",
      symbology: "code_39",
      raw: "1HGCM82633A004352",
      checkDigitValid: true,
    });

    expect(record.vin).toBe("1HGCM82633A004352");
    expect(await db.vehicles.count()).toBe(1);
    // And the row that will sync it later is queued all the same (§4.12, §5.7).
    expect(await db.outbox.count()).toBe(2);
  });
});
