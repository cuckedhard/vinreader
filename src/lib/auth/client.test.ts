/**
 * `getSupabase()` has exactly one job that matters to the rest of the app: **it must answer
 * `null` for every build that cannot have a client, and it must never throw.**
 *
 * That is not a defensive nicety. The unconfigured build is the one most users run — §7 item
 * 2 requires the whole slice to work offline and signed out — and the sync engine calls this
 * on its own schedule, not on a screen the user opened. A throw here is a blank app for
 * someone standing next to a truck who never asked for an account.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSupabase, resetSupabaseClient, supabaseAvailability } from "./client";

const URL_KEY = "VITE_SUPABASE_URL";
const KEY_KEY = "VITE_SUPABASE_ANON_KEY";

/** Shaped like the real thing; never contacted, because nothing here signs in. */
const URL_VALUE = "https://project.supabase.co";
const ANON_KEY = "anon.key.value";

beforeEach(() => {
  resetSupabaseClient();
  vi.stubEnv(URL_KEY, undefined);
  vi.stubEnv(KEY_KEY, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetSupabaseClient();
});

describe("an unconfigured build", () => {
  it("has no client, and says why", () => {
    expect(getSupabase()).toBeNull();
    expect(supabaseAvailability()).toBe("not_configured");
  });

  it.each([
    ["only the URL", URL_VALUE, undefined],
    ["only the anon key", undefined, ANON_KEY],
  ])("has no client with %s", (_label, url, key) => {
    vi.stubEnv(URL_KEY, url);
    vi.stubEnv(KEY_KEY, key);

    expect(getSupabase()).toBeNull();
    expect(supabaseAvailability()).toBe("not_configured");
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
  ])("treats an %s value as absent rather than as a URL to be rejected", (_label, url) => {
    // A name with nothing after the `=` in .env.local. `createClient` would throw on it,
    // which would report a deployment mistake for what is really an unfinished .env — and
    // the two states want different words on the Account screen.
    vi.stubEnv(URL_KEY, url);
    vi.stubEnv(KEY_KEY, ANON_KEY);

    expect(getSupabase()).toBeNull();
    expect(supabaseAvailability()).toBe("not_configured");
  });
});

describe("a misconfigured build", () => {
  it("reports invalid_config instead of throwing out of the import graph", () => {
    // Real shape of the mistake: a host pasted without its scheme. supabase-js throws
    // "Invalid supabaseUrl" from the constructor, which the sync engine would meet on app
    // start, not on a screen anyone opened.
    vi.stubEnv(URL_KEY, "project.supabase.co");
    vi.stubEnv(KEY_KEY, ANON_KEY);

    expect(() => getSupabase()).not.toThrow();
    expect(getSupabase()).toBeNull();
    expect(supabaseAvailability()).toBe("invalid_config");
  });

  it("does not retry the failed construction on every call", () => {
    vi.stubEnv(URL_KEY, "project.supabase.co");
    vi.stubEnv(KEY_KEY, ANON_KEY);
    getSupabase();

    // Fixing the env without a reload cannot fix the client: the decision is made once per
    // tab, and the caller that meets a null must keep meeting it rather than getting a
    // client halfway through a push.
    vi.stubEnv(URL_KEY, URL_VALUE);
    expect(getSupabase()).toBeNull();
    expect(supabaseAvailability()).toBe("invalid_config");
  });
});

describe("a configured build", () => {
  beforeEach(() => {
    vi.stubEnv(URL_KEY, URL_VALUE);
    vi.stubEnv(KEY_KEY, ANON_KEY);
  });

  it("builds a client and reports it ready", () => {
    expect(getSupabase()).not.toBeNull();
    expect(supabaseAvailability()).toBe("ready");
  });

  it("hands out the same client for the lifetime of the tab", () => {
    // One client owns the persisted session and the refresh timer. A second would race the
    // first over the same storage key, and §4.12 has one session per device.
    const first = getSupabase();
    expect(getSupabase()).toBe(first);
    expect(getSupabase()).toBe(first);
  });

  it("trims a value that arrived with whitespace around it", () => {
    vi.stubEnv(URL_KEY, ` ${URL_VALUE} `);
    resetSupabaseClient();

    expect(supabaseAvailability()).toBe("ready");
  });

  it("does not read the URL fragment, which belongs to HashRouter and §4.9", () => {
    // `detectSessionInUrl: false`. v1 has no redirect flow to detect (§12 rules out OAuth,
    // and the 6-digit code is typed into the app), so the only thing the option could do is
    // let supabase-js read and rewrite a hash carrying a handoff payload.
    const auth = getSupabase()?.auth as unknown as { detectSessionInUrl: boolean };
    expect(auth.detectSessionInUrl).toBe(false);
  });

  it("persists the session and refreshes it, per §4.12", () => {
    const auth = getSupabase()?.auth as unknown as {
      persistSession: boolean;
      autoRefreshToken: boolean;
    };
    expect(auth.persistSession).toBe(true);
    expect(auth.autoRefreshToken).toBe(true);
  });
});

describe("the key that ships", () => {
  it("is the anon key and nothing else (CLAUDE.md rule 12)", () => {
    // A service-role key bypasses every RLS policy in supabase/migrations/0001_init.sql, and
    // any `VITE_`-prefixed variable is compiled into the bundle — so a single line reading
    // one from `import.meta.env` would publish it to every visitor. No behavioural test can
    // catch that; reading the source can.
    const source = readFileSync(new URL("./client.ts", import.meta.url), "utf8");
    const names = [...source.matchAll(/import\.meta\.env\?\.(\w+)/g)].map((match) => match[1]);

    expect(names).toEqual([URL_KEY, KEY_KEY]);
    expect(source).not.toMatch(/SERVICE_ROLE/i);
  });

  it("reads both names as static property accesses, so Vite can replace them", () => {
    // Vite substitutes the literal text `import.meta.env.VITE_X` at build time. A computed
    // lookup survives dev — where `import.meta.env` is a real object — and reads `undefined`
    // in the production bundle: sign-in that works on the laptop and silently does nothing
    // on the phone that was actually shipped.
    const source = readFileSync(new URL("./client.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/import\.meta\.env\??\.?\[/);
  });
});
