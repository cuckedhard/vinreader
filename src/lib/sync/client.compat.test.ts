/**
 * The narrow client surface, checked against the real one.
 *
 * `SyncClient` exists so the engine can be driven by an in-memory fake, and a fake proves
 * nothing if it is easier to satisfy than `@supabase/supabase-js`. So this file asserts, at
 * the type level, that a real `SupabaseClient` **is** a `SyncClient`: if the two ever drift
 * — a signature this engine calls that the library does not have, an option shaped
 * differently — `bun run typecheck` fails here rather than the app failing in a parking lot.
 *
 * It is a type test, so it declares its client rather than constructing one: `createClient`
 * would start a session refresh timer in a unit test, and nothing here needs a runtime.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { SyncClient } from "./types";

/** The whole assertion: a compile error here means the engine is calling something else. */
function narrow(client: SupabaseClient): SyncClient {
  return client;
}

describe("SyncClient", () => {
  it("is a surface a real SupabaseClient already satisfies", () => {
    expect(typeof narrow).toBe("function");
  });
});
