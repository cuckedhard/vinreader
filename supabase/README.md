# VIN Relay — the Supabase backend (S4)

This directory is the whole server side of VIN Relay: two tables, the triggers and functions that
merge them, the row-level security that separates one account from another, and one Edge Function
that deletes an account. There is no server code beyond this — the app talks to Postgres directly
through Supabase's API, and every rule about who may see what is enforced by the database.

Signing in is optional (N7). Everything in S0–S3 works signed out, on the device, with no account
and no network; this directory only exists so that the same VIN history can appear on a second
device when the user asks for it.

If you have never used Supabase: it is a hosted PostgreSQL with an HTTP API in front of it
(PostgREST), an authentication service (GoTrue), a change-feed (Realtime) and a Deno function
runtime. The CLI runs all of that locally in Docker, so you can develop against the real thing.

## What is in here

| Path                         | What it is                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `migrations/0001_init.sql`   | The entire schema: tables, indexes, RLS policies, triggers, RPCs (§4.12).              |
| `migrations/0002_paint_code.sql` | S5: `vehicles.paint` (§4.9 `pc`) and the `p_paint` argument on `upsert_vehicle_meta`. |
| `functions/delete-account/`  | The Edge Function that deletes an account. The only holder of the service-role key.    |
| `config.toml`                | What `supabase start` brings up locally.                                               |
| `tests/00_stub_supabase.sql` | Stubs `auth.users`, `auth.uid()` and the three roles so the tests run on any Postgres. |
| `tests/10_rls_test.sql`      | The §9-S4 requirement: a second user can neither read nor write the first user's rows. |
| `tests/20_merge_test.sql`    | The §4.12 merge rules and the aggregate triggers.                                      |
| `tests/run.sh`               | Runs the tests against a database URL.                                                 |

## What you need first

- **Docker**, running. The local stack is containers; the CLI will not start without it.
- **The Supabase CLI** — `brew install supabase/tap/supabase`, `scoop install supabase`, or the
  binary from https://github.com/supabase/cli/releases. `supabase --version` should answer.
- **`psql`**, for the tests only. It ships with the PostgreSQL client tools (`brew install libpq`,
  `apt install postgresql-client`).
- Nothing else. You do not need Deno, or a Postgres of your own; the CLI supplies both.

Run every command below from the **repository root** (the directory holding `supabase/`), not
from inside this directory.

## Bring it up locally, from nothing

```bash
supabase start
```

The first run downloads several gigabytes of images and takes a few minutes; later runs take
seconds. When it finishes it prints a block of URLs and keys — keep the terminal, or get them
again any time with `supabase status`:

| Line               | What it is                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `API URL`          | `http://127.0.0.1:54321` — this is `VITE_SUPABASE_URL`.                                                    |
| `anon key`         | The public key the app ships with — this is `VITE_SUPABASE_ANON_KEY`.                                      |
| `service_role key` | Bypasses every policy in this file. It does not go in the app, in `.env`, in a commit, or in a screenshot. |
| `DB URL`           | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` — for `psql` and the tests.                      |
| `Inbucket URL`     | `http://127.0.0.1:54324` — the local mailbox where sign-in emails land.                                    |

`supabase start` applies everything in `migrations/` as it comes up, so the schema is already
there. Point the app at it:

```bash
cat >> .env.local <<'EOF'
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<the anon key printed above>
EOF
bun run dev
```

`.env.local` is git-ignored (`*.local`). `.env.example` documents both names.

Useful afterwards:

```bash
supabase status        # the URLs and keys again
supabase db reset      # drop everything, re-apply migrations/ from scratch
supabase stop          # shut the stack down
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')"   # a SQL prompt
```

### The 6-digit sign-in code needs one template change

§4.12 signs in with `signInWithOtp` and a **6-digit code**, not a magic link. GoTrue's stock email
template sends only a link, so out of the box the code the sign-in screen asks for never arrives.
The template has to include `{{ .Token }}`.

- **Hosted:** Dashboard → Authentication → Email Templates → _Magic Link_. Add `{{ .Token }}`
  somewhere in the body. This is a one-time, per-project change and is not in this repository.
- **Local:** write a template file containing `{{ .Token }}` — `supabase/templates/magic_link.html`
  is the conventional place — and uncomment the `[auth.email.template.magic_link]` block in
  `config.toml` so it is used. Then restart the stack. Without it, read the code out of the
  message body in Inbucket, which shows the raw email either way.

## Deploy to a hosted project

```bash
supabase login                              # opens a browser, stores a token
supabase link --project-ref <your-ref>      # the ref is in the dashboard URL and in Settings → General
supabase db push                            # applies everything in migrations/ to the hosted database
supabase functions deploy delete-account    # deploys the Edge Function
```

Then, in the dashboard:

1. **Settings → API** — copy the _Project URL_ and the _anon public_ key into the host's build
   environment as `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. The _service_role_ key stays
   in the dashboard; the Edge Function receives it automatically as `SUPABASE_SERVICE_ROLE_KEY`
   and nothing else in this project may hold it (CLAUDE.md rule 12).
2. **Authentication → Email Templates** — add `{{ .Token }}` to the magic-link template (above).
3. **Database → Publications** — confirm `supabase_realtime` lists `vehicles`. The migration adds
   it; §4.12's realtime signal does not arrive without it.
4. **Authentication → URL Configuration** — set the site URL to wherever the PWA is hosted.

`supabase db push` is safe to re-run: it applies only migrations the target has not seen.

## Run the tests

The §9-S4 definition of done requires that "a second test user cannot read or write the first
user's rows (RLS test in CI)". That test is `tests/10_rls_test.sql`; `tests/20_merge_test.sql`
covers the §4.12 merge rules beside it. Both are plain SQL — no pgTAP, no test framework — and
each is a single transaction that ends in `ROLLBACK`, so running them leaves nothing behind.

Against the local stack:

```bash
supabase/tests/run.sh
```

Against any database that already has the schema:

```bash
supabase/tests/run.sh "postgresql://user:pass@host:5432/dbname"
```

Against a bare, empty PostgreSQL — no Docker, no Supabase, which is what makes this runnable in
CI:

```bash
supabase/tests/run.sh --bootstrap "postgresql://postgres@127.0.0.1:5432/vinrelay_ci"
```

`--bootstrap` applies `00_stub_supabase.sql` (the `anon`/`authenticated`/`service_role` roles, an
`auth.users` table for the foreign keys, and `auth.uid()`) and then the migration itself. On a
real Supabase database the stub finds all of that already present and does nothing.

Success looks like two lines:

```
RLS TEST PASSED
MERGE TEST PASSED
```

Anything else is a failed assertion; the message names the rule that broke. The runner exits
non-zero on the first one.

**What these tests do and do not prove.** They exercise the real policies, triggers and functions
against a real PostgreSQL, and each test was checked against a deliberately broken schema to
confirm it fails when it should — RLS disabled, a policy widened to `using (true)`, a missing
trigger, a `security definer` function appearing in `public`. They are a test of the database.
They are not a test of GoTrue: a test "is" a user by setting `request.jwt.claims` and the
connection role, exactly as PostgREST does per request, but nothing here checks that GoTrue would
have issued that JWT in the first place. Sign-in itself needs the running stack.

## What the schema does

**`vehicles`** is keyed by `(user_id, vin)` — one row per VIN per account, which is §5.3's upsert
rule expressed as a primary key. **`scan_events`** is the append-only log, keyed by a UUID the
client generates before it pushes.

Events are the truth and the vehicles row is a cache of them (P8):

- `scan_events_apply` (after insert) creates or updates the vehicles row — `scan_count + 1`,
  earliest `first_scanned_at`, latest `last_scanned_at`, and `deleted_at` cleared, because §4.12
  says a later scan undoes a soft delete.
- `scan_events_recount` (after delete) re-derives those three from what is left, so deleting
  events cannot leave the row claiming scans that no longer exist.
- `scan_events_append_only` (before update) refuses updates outright. Nothing in the protocol
  updates an event, and an update that changed `at` or `vin` would silently desync every
  aggregate above.
- `vehicles_touch` (before update) sets `updated_at = now()`. That column is the pull cursor: the
  client asks for `updated_at >= cursor`, so a change that did not touch it would never reach the
  other device.

The client never writes the derived columns. It calls three functions instead, all of which run
as the caller so that RLS still applies:

- `upsert_vehicle_meta(vin, unit, notes, meta_updated_at, structural, decode)` — the §4.12 merge
  rules: unit and notes are last-writer-wins on the client's `meta_updated_at` clock with ties
  keeping what is there, `structural` is first-non-empty, and `decode` is ranked
  `ok > partial > unsupported > pending/failed` with newer `fetchedAt` breaking a tie.
- `delete_vehicle(vin)` — soft delete. The row stays and `deleted_at` is set, so other devices
  pull the tombstone and remove their copies.
- `delete_my_data()` — removes the caller's rows from both tables and nothing else. The account
  itself survives; that is what the Edge Function is for.

Three indexes, one per query that matters: `vehicles_user_updated` and `scan_events_user_inserted`
serve the two pull queries (and are what the account-deletion cascade walks instead of scanning
the tables), and `scan_events_user_vin` serves the recount above.

## The security posture

Everything rests on one predicate. Both tables have RLS enabled with a single policy —
`using (user_id = auth.uid()) with check (user_id = auth.uid())` — so a query for another user's
rows returns nothing and a write of another user's rows is refused, whatever the client sends.
The client only ever holds the anon key; `auth.uid()` comes from the verified JWT.

Four things keep that true, and each is asserted in `tests/10_rls_test.sql`:

1. **No `security definer` function.** Such a function runs as the owner, who bypasses RLS, which
   would make one mistyped `where` clause into a leak of every account. There is not one in this
   schema, and the test fails if one appears.
2. **`with check` on writes, not just `using` on reads.** Without it a user could hand a row to
   another account by rewriting `user_id`.
3. **No table without a policy.** RLS with no policy denies everything, which is safe but silent;
   the test asserts both that RLS is on and that a policy exists, so a future table cannot arrive
   half-configured.
4. **The service-role key exists in exactly one place** — the `delete-account` function, from the
   environment, never from a literal, and the function refuses to run if it is missing. That key
   bypasses RLS entirely, which is why deleting the auth user is the _only_ thing done with it.

The function verifies the caller before it touches anything: it takes the `Authorization` header,
asks the Auth server who it belongs to, and deletes that id and no other. The platform's own
`verify_jwt` gate is not enough on its own — the anon key is itself a valid JWT signed by the
project, so it passes that gate — which is why both checks exist.

## When something does not work

| Symptom                                                    | Cause                                                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `supabase start` fails immediately                         | Docker is not running, or ports 54321–54324 are taken. `supabase stop` first, then start again.                  |
| `new row violates row-level security policy`               | The caller is signed out, or is writing a `user_id` that is not their own. That error is the wall doing its job. |
| Reads return `[]` for rows you can see in Studio           | Studio connects as the owner and bypasses RLS. The app does not. Check which account is signed in.               |
| The sign-in code never arrives                             | The email template has no `{{ .Token }}` — see above. Locally, read the message in Inbucket.                     |
| Rows sync but nothing arrives live                         | `vehicles` is not in the `supabase_realtime` publication, or the subscription filter does not match `user_id`.   |
| `supabase db push` reports nothing to do                   | The migration is already applied there. `supabase migration list` shows local against remote.                    |
| The tests fail with `relation "auth.users" does not exist` | Run through `run.sh`, which applies the stub first, rather than calling `psql` on a test file directly.          |

## What this directory has not been proved to do

The schema and both test files were executed — against PostgreSQL 16 with the `auth` stub, not
against a Supabase stack, because the environment this slice was built in has no Docker daemon and
cannot reach `api.supabase.com`. So `supabase start`, `supabase db push`, the Edge Function's
deployment and its runtime behaviour, the config keys in `config.toml`, Realtime delivery and the
sign-in flow have all been written from the documented contracts and **not run**. The S4 session
report lists exactly what that leaves open. Bring the stack up once on a machine with Docker
before trusting any of it in the field.
