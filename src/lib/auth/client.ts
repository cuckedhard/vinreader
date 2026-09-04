/**
 * The app's one supabase-js client (§4.12).
 *
 * Three rules shape this file.
 *
 * **Null is the normal answer.** A build with no `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
 * is not broken — it is the app every user who never signs in runs, and §7 item 2 says the
 * slice works offline. So `getSupabase()` returns `null` rather than throwing, and every
 * caller has to tolerate it. It also returns `null` when `createClient` itself rejects the
 * values, because a typo in `.env.local` must degrade to "sync unavailable", never to a
 * blank screen: this module is imported by the sync engine, which the app starts on its own.
 *
 * **Lazily, once, for the lifetime of the tab.** The client owns the persisted session and
 * the refresh timer; a second one would race the first over the same storage key. Nothing is
 * constructed until someone asks, so importing this file costs nothing on the scan path (N7).
 *
 * **Only the anon key ships** (CLAUDE.md rule 12). The service-role key bypasses every RLS
 * policy in `supabase/migrations/0001_init.sql` and exists only in the `delete-account` Edge
 * Function, where the platform injects it. A `VITE_`-prefixed variable is compiled into the
 * bundle, so there is deliberately no name for it here.
 */
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Why this build has no client, when it has none.
 *
 * `not_configured` is expected and quiet — no env vars, so no account features.
 * `invalid_config` is the loud one: the two variables are set and `createClient` still
 * refused them, which is a deployment mistake no user can fix and no retry will cure.
 * The Account screen is the one place that can say so (P7).
 */
export type SupabaseAvailability = "ready" | "not_configured" | "invalid_config";

let client: SupabaseClient | null = null;
/** `null` means "not built yet"; the first `getSupabase()` decides once. */
let availability: SupabaseAvailability | null = null;

/**
 * An env var counts as set only when it is a non-empty string. `.env` files hand back `""`
 * for a name with nothing after the `=`, and an empty URL passed to `createClient` throws —
 * which would turn a half-filled `.env.local` into `invalid_config` instead of the plain
 * "this build has no account features" it actually is.
 */
function envValue(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Both variables are read as static property accesses, never through a computed key: Vite
 * replaces `import.meta.env.VITE_X` at build time by matching that exact text, so a dynamic
 * lookup would read the values in dev and `undefined` in the production bundle — a build
 * where sign-in silently does nothing.
 */
function build(): SupabaseAvailability {
  const url = envValue(import.meta.env?.VITE_SUPABASE_URL);
  const anonKey = envValue(import.meta.env?.VITE_SUPABASE_ANON_KEY);
  if (url === null || anonKey === null) return "not_configured";

  try {
    client = createClient(url, anonKey, {
      auth: {
        // §4.12: "Session persisted by supabase-js and refreshed when online."
        persistSession: true,
        autoRefreshToken: true,
        /**
         * The URL fragment belongs to `HashRouter` and to §4.9's handoff payloads
         * (`/#/i?d=…`), not to Supabase. v1 has no redirect-based flow to detect — email
         * plus a 6-digit code is entered in the app, and §12 rules out OAuth — so leaving
         * this on would only give supabase-js a reason to read and rewrite a hash that
         * carries a vehicle record.
         */
        detectSessionInUrl: false,
      },
    });
    return "ready";
  } catch {
    client = null;
    return "invalid_config";
  }
}

function ensureBuilt(): SupabaseAvailability {
  if (availability !== null) return availability;
  const built = build();
  availability = built;
  return built;
}

/**
 * The client, or `null` when this build has none. Callers must handle `null` — it is the
 * signed-out, unconfigured, works-anyway path, not an error.
 */
export function getSupabase(): SupabaseClient | null {
  ensureBuilt();
  return client;
}

/** Why `getSupabase()` returned what it returned. Building the client if it has not been. */
export function supabaseAvailability(): SupabaseAvailability {
  return ensureBuilt();
}

/**
 * Tests only. The decision above is made once per module instance and cached forever, which
 * is exactly right in a tab and useless in a test file that stubs the env between cases.
 */
export function resetSupabaseClient(): void {
  client = null;
  availability = null;
}
