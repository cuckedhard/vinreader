/**
 * `delete-account` (§4.12, §9-S4) — the only place in this project where the service-role key
 * exists (CLAUDE.md rule 12).
 *
 * Deleting a user is the one operation the client cannot perform for itself: `auth.users` is
 * GoTrue's table, RLS does not reach it, and the anon key has no admin rights. So the request
 * arrives here with the caller's own JWT, is verified against the Auth server, and only then is
 * the service-role key used — for exactly one call, on exactly the id that JWT belongs to. The
 * user's rows follow through the `on delete cascade` on both foreign keys in 0001_init.sql
 * (asserted in supabase/tests/20_merge_test.sql), so nothing here touches `public`.
 *
 * The key is read from the environment and never from a literal, and its absence fails the
 * request rather than degrading to something that still half-works.
 *
 * Deployed with `supabase functions deploy delete-account`. Runs on Deno, not in the app bundle.
 */

import { createClient } from "npm:@supabase/supabase-js@2.115.0";

// The Deno global, as this file uses it. Declared locally because the repo's tsconfig and ESLint
// describe a browser bundle and know nothing about the edge runtime; inside a module this
// shadows the real global with a compatible subset rather than redefining it.
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (req: Request) => Promise<Response>): void;
};

/**
 * The browser calls this from the installed PWA, whose origin is not known at deploy time
 * (§8 Q1). `*` is safe here and only here: authority is the bearer token, never a cookie, so a
 * hostile page gains nothing by being allowed to send a request it cannot sign.
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  // Deleting an account is not something a link or an <img> should be able to trigger.
  if (req.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  // Supplied by the platform to every function; `SUPABASE_`-prefixed names are reserved and
  // cannot be set by hand, so a missing one means the function is running somewhere it should
  // not be. Fail closed, and say nothing about which name is missing.
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceRoleKey) {
    console.error("delete-account: refusing to run without url, anon key and service-role key");
    return json(500, { error: "not_configured" });
  }

  // Nothing above this line has touched the database, and nothing below it does until the JWT
  // has been verified. A malformed header is refused here, before any client is constructed.
  const bearer = /^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/.exec(req.headers.get("Authorization") ?? "");
  if (!bearer) {
    return json(401, { error: "unauthorized" });
  }
  const token = bearer[1];

  try {
    // The platform's own `verify_jwt` gate is not sufficient on its own: the anon key is itself
    // a JWT signed with the project secret, so it passes that gate. `getUser(token)` is what
    // separates a signed-in person from an anonymous caller — it asks the Auth server to
    // validate that token's signature, expiry and session, and a key with no `sub` fails it.
    // The token is passed explicitly rather than through a session or a global header, so which
    // credential is being checked does not depend on how the client was configured.
    const caller = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await caller.auth.getUser(token);
    if (error || !data.user) {
      return json(401, { error: "unauthorized" });
    }

    // Only now, and only for the id that token proved. `shouldSoftDelete` is passed explicitly:
    // a soft delete would leave the user's rows in place, which is the opposite of what the
    // §6.4 confirmation promised.
    const admin = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: deleteError } = await admin.auth.admin.deleteUser(data.user.id, false);
    if (deleteError) {
      console.error("delete-account: deleteUser failed", deleteError.message);
      return json(500, { error: "delete_failed" });
    }

    return json(200, { ok: true });
  } catch (cause) {
    // P7: loud in the log, plain to the user. The client shows the §6.4 failure copy; it never
    // sees an internal message.
    console.error("delete-account: unexpected failure", cause);
    return json(500, { error: "delete_failed" });
  }
});
