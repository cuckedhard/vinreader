# S4 session report

Slice S4, accounts and cloud history — the last slice of v1. Read this before `harden S4`, and
before pointing the app at a real Supabase project.

## State

**Built**, per §7 items 1, 2, 3, 5 and 6, with a qualification no earlier slice needed: **the
server half has never run against Supabase.** The schema and its tests ran against a scratch
PostgreSQL; everything the client does over the network ran against an in-memory fake. Not
hardened, and not done — §7 item 4 is untouched, and every check below was emulation.

## Gate

| Check                               | Result                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `bun run typecheck`                 | clean                                                                                      |
| `bun run lint`                      | clean                                                                                      |
| `bun run test`                      | 1249 passing, 68 files (was 548 / 20 at S3); S4's own 26 new test files carry 342          |
| `supabase/tests/run.sh --bootstrap` | `RLS TEST PASSED` / `MERGE TEST PASSED`, exit 0, on PostgreSQL 16.13 with the `auth` stub  |
| `bun run build`                     | app 1,026 kB / 297 kB gzipped, plus a 214 kB / 55.6 kB Supabase chunk; 16 precache entries |
| `bun run test:e2e`                  | 42 desktop, 76 Android — **from the last gate run, not re-run here**                       |
| `bun run test:coverage`             | 99.22% statements, 97.18% branches — same provenance                                       |
| `bun run mutate`                    | 85.01% on `src/lib` against §13.5's 80 — same provenance, and see below                    |
| `bun run bench`                     | FAIL, 16 §13.6 thresholds missed, 1 false accept (R4-F); untouched by this slice           |

The first five rows I ran in this session on this tree. The last four are quoted, and two carry
caveats worth more than the numbers:

- **The mutation score predates part of S4.** It was measured on 1,157 tests; the tree has 1,249,
  and `src/lib/sync/accountDeletes.ts` was written after that run and has never been mutated at
  all. Inside the run that exists, `src/lib/sync` scores **78.13%** and `src/lib/auth` 81.48% — the
  aggregate passes because the S0–S3 directories carry it. Ledger item M4, open.
- **No end-to-end test touches anything S4 added to the UI.** Checked statically: no spec under
  `tests/e2e/` mentions `/#/account`, Copy TSV, Copy CSV, the sync chip or the 900 px table. The 42
  and the 76 are S0–S3's, which is what makes "all of S0–S3 still pass signed out" the one DoD
  extra below with real evidence.

## Tested, and tested against the thing that will actually run

**Against a real PostgreSQL.** `0001_init.sql`, `10_rls_test.sql` and `20_merge_test.sql` execute —
I re-ran them here on a scratch 16.13 cluster and both printed their PASSED line. They exercise the
real policies, triggers and functions, and each was checked against a deliberately broken schema
(RLS off, a policy widened to `using (true)`, the recount trigger dropped) to confirm it fails when
it should. **But a test "is" a user by setting the connection role and putting claims in
`request.jwt.claims`** — what PostgREST does per request, and no evidence at all that GoTrue would
have issued that JWT or that PostgREST would have passed it through. The wall is tested; the gate
in front of it is not. Two more gaps in §9-S4's wording: `00_stub_supabase.sql` supplies
`auth.users`, `auth.uid()` and the three roles, so this is the migration on a stub rather than on
Supabase; and "RLS test **in CI**" is not met, because there is no `.github/` and no CI.

**Against a fake.** The whole client protocol — push, pull, merge, realtime, status, sign-out, both
account deletes — runs against `src/lib/sync/supabaseFake.testutil.ts`, an in-memory
PostgREST-and-Postgres transcribed from the migration rather than from `merge.ts`, quirks included.
`client.compat.test.ts` narrows a real `SupabaseClient` to the engine's `SyncClient` at the type
level, so the fake cannot be a shape the library would not satisfy. That is worth something, and it
is still not the database: a faithful transcription is a second implementation of one reading of
the SQL, and both copies can be wrong in the same direction.

**Never ran.** No Docker daemon here and `api.supabase.com` blocked, so `supabase start`,
`db push`, `functions deploy`, the Edge Function's runtime, `config.toml`'s keys, Realtime delivery
and **sign-in itself** were written from documented contracts and executed zero times.

## §9-S4's definition-of-done extras

| Extra                                                           | Verdict                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Phone scan over cellular → row on a signed-in laptop, no reload | **Not observed.** Realtime has never delivered a message; the fake calls the subscriber in-process on a write.      |
| Airplane-mode scans plus a unit edit sync on reconnect in order | **Not observed.** Passes as a fake scenario, with the drain proven order-preserving across kinds.                   |
| Two devices editing the same unit converge on the later edit    | **Not observed.** Passes as a fake scenario; the same rule is asserted in real SQL in `20_merge_test.sql`.          |
| A second user cannot read or write the first's rows (RLS in CI) | **Ran**, with the two qualifications above: a stubbed `auth`, and no CI.                                            |
| Copy TSV pasted into Google Sheets and Excel                    | **Not observed.** Column order is imported from `src/lib/payload`, escaping is unit-tested, no sheet has opened it. |
| Sign out and clear leaves no records or session                 | **Half.** The Dexie wipe is tested against `fake-indexeddb`; the session half is supabase-js's own storage.         |
| All of S0–S3 still pass signed out                              | **Yes, as far as automation goes**, and the engine is asserted to make zero requests when signed out.               |

Three of the seven are the headline features of the slice, and none of the three has been seen to
happen.

## What works, and what backs it

- The write path feeds the outbox **atomically** — each append inside the writer's own Dexie
  transaction — proved by breaking the outbox store and asserting the vehicle write rolled back
  with it, and by the mirror. That settled a contradiction in the brief: atomicity and "a scan
  still saves when the outbox is broken" are mutually exclusive, and atomicity won, because a scan
  saved without its row never syncs and never says so, while a rollback fails loudly to someone
  standing at the truck.
- **N7 is checkable rather than asserted.** A static test reads all seven files in
  `src/lib/storage` and fails if any imports a specifier matching `supabase` or `auth`; a
  behavioural one saves a scan with `getSupabase()` throwing on every call; and `useAuth` rendered
  through `renderToStaticMarkup` reaches first paint with the client never constructed.
- Push drains in insertion order, grouping **consecutive** same-kind rows into batches of 50, so
  §4.12's two phrases both hold and a delete cannot overtake a re-scan. Pull is the one apply path,
  keyset-paged, cursor forward only, with the unpushed-meta rule evaluated inside the same
  transaction that reads the outbox.
- The security posture is asserted, not claimed: RLS on both tables, `with check` on writes, no
  policy-less table, no `security definer` function anywhere, `TRUNCATE` revoked from
  `authenticated` — RLS does not apply to it at all — and everything revoked from `anon`.

## Decisions taken under §0 rule 4

- **`apply_scan_event` was left exactly as §4.12 writes it**, seeding `meta_updated_at` from the
  event clock even though the column means "client clock at last unit/notes edit" and a scan is not
  an edit. It is a merge semantic and §4.12 owns it. First item below.
- `better_decode` is marked **STABLE, not IMMUTABLE**: a bare timestamp literal really does differ
  between two `TimeZone` settings, checked against the catalog and by experiment. A promise to the
  planner, not a merge rule. `decode_rank` is genuinely immutable and untouched.
- `scan_events_recount` added — statement-level AFTER DELETE, re-deriving count, min and max for
  the affected `(user_id, vin)` pairs. §4.12 defines `scan_count` as "number of events" and the
  skeleton only ever adds; `delete_my_data` and the account cascade both delete, and other devices
  would then pull a count matching nothing (N2). Also `scan_events_append_only`, and one index for
  the recount to aggregate by.
- `softDeleteVehicle` added locally: §4.12 names delete as a feeding path and `vehicle_delete` as a
  kind, and S0–S3 had no local delete writer, so the kind would have shipped as dead code. **No
  Dexie version bump** — `outbox` and `syncState` have been in `version(1)` since S0.
- A push failure with no server verdict stops the whole drain rather than hammering a dead radio; a
  rejected multi-row batch is re-sent one row at a time, so one poisoned row cannot wedge forty-nine.
- **Six statuses, four strings, no fifth invented.** `signed_out` renders no chip at all: every
  §6.4 string is a claim about an account, and a signed-out device — or an unconfigured build, which
  lands in the same place — has none, so "Synced" would be false and "3 pending" would name an
  account the user never had (N2). `syncing` renders the state it is leaving, which stays true for
  the whole request.
- `armUploadPrompt()` runs on the line **before** `verifyCode`, so §5.6's gate is already shut when
  the session opens. After it, "Not now" undoes nothing while every unit test still passes, because
  the engine's first cycle is not something a node-environment test observes.
- §6.6's 900 px lives once, in `src/app/viewport.ts`, and is **sampled** rather than subscribed to.
  A default is asked once on arrival; dragging a window across the threshold navigates nobody.
- `supabaseAvailability()` distinguishes `ready` / `not_configured` / `invalid_config`, and
  `getSupabase()` returns null rather than throwing out of an import graph the engine starts on its
  own. §4.12 does not say what a mistyped env var looks like; naming which is P7.

## Open for Zach

1. **`meta_updated_at` seeded from the event clock.** A unit typed on device A at 10:01 loses to a
   scan of the same VIN by device B at 12:00 when A pushes late. The client protects its own side
   (D11's epoch sentinel); the trigger does not. Already raised as spec item O04. As of this
   writing the tree still has the literal skeleton, with the consequence characterised in
   `20_merge_test.sql` under "The meta clock a scan leaves behind" — approve seeding the epoch and
   that block is the assertion that flips red, deliberately.
2. **R4-F**, the `code_128` severe false accept — still open, still the number §13.6 criterion 4
   exists to protect.
3. **The §2 compatibility floor** — Chrome 99 / Safari 16.4, set by Tailwind v4's emitted CSS. The
   only lever is a locked-stack change.
4. **Does the decode queue feed the outbox?** It does not, and that deserves confirming rather than
   assuming: §5.4's queue writes `decode` straight to `db.vehicles` without passing through
   `upsertVehicle`, so a vPIC result reaches the account on the _next_ write for that VIN and not
   when it lands. A VIN scanned once and never edited decodes on this phone and stays `pending` in
   the account. Queuing a `vehicle_meta` row per decode fixes it, at one push per decoded VIN.
5. **§8 question 1** — product name and host domain. The Edge Function's CORS is `*` because the
   PWA's origin is not known at deploy time; safe there and only there, since authority is a bearer
   token and never a cookie, but it wants a real origin.
6. **§8 question 5** — hosting, and whether a Supabase project exists to reuse. Nothing in this
   slice can be verified until one does. Related: §4.12 requires the sign-in email to carry
   `{{ .Token }}`, and GoTrue's stock template carries only `{{ .ConfirmationURL }}` — a project
   left that way makes every call in `src/lib/auth/` succeed while no code ever arrives.

## What only you can verify (§7 item 4, §13.7)

Every row above that says "not observed", and each needs two devices and a real project. Beyond
them: whether the 6-digit code arrives at all; whether an installed iOS PWA keeps a session across
a cold start; whether Copy TSV survives Google Sheets _and_ Excel, which disagree about TSV;
whether the clipboard writes on a real iPhone, which §11 flags as failing silently and which S3
owed you already; and whether the §6.6 table is usable on a laptop with no touch.

The largest untested surface in the tree is `AccountScreen.tsx` at 576 lines — no unit test, no
e2e; its pure parts are extracted and tested, its rendering is not. `HistoryScreen.tsx` (557),
`HistoryTable.tsx`, `SheetPane.tsx` and `copy.tsx` are in the same position. That is ledger item
M11 widened by this slice.

## For `harden S4`

The §13.5 gate cannot be believed for this slice until three things happen in this order: bring the
stack up on a machine with Docker and re-run `supabase/tests/run.sh` against the real thing; write
e2e for the S4 screens, which the node runner cannot reach; then re-run `bun run mutate`, which has
no measurement at all for `accountDeletes.ts` and a failing one for `src/lib/sync`.
`supabase/README.md` is the operator's document and carries its own list of what is unproved; it
and this report should stay in agreement.
