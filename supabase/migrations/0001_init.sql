-- VIN Relay — S4 cloud sync schema (§4.12).
--
-- §4.12's SQL skeleton is authoritative for names, keys and merge semantics; this file completes
-- it and renames nothing in it. Every statement the skeleton spells out is reproduced verbatim
-- apart from the two marked below, and everything else is an addition. The full list, so that a
-- diff against §4.12 needs no detective work:
--
--   1. `scan_events_vin_grammar` — the §4.1 check the skeleton puts on vehicles.vin, on the log too.
--   2. `scan_events_recount`     — the skeleton keeps `scan_count` honest on insert only, so a
--                                  delete (`delete_my_data`, or the auth.users cascade) leaves the
--                                  aggregate claiming events that no longer exist.
--   3. `scan_events_append_only` — P8 says events are the truth; an UPDATE would silently desync
--                                  every aggregate derived from them.
--   4. `scan_events_user_vin`    — the recount aggregates by (user_id, vin); nothing else indexes it.
--   5. grants and revokes        — RLS decides which *rows* a role sees; table privileges decide
--                                  whether it reaches the table at all, and TRUNCATE ignores RLS.
--   6. realtime publication      — §4.12 requires `postgres_changes` on `vehicles`.
--   7. CHANGED: `better_decode` is STABLE, not IMMUTABLE — see the note above the function. It is
--                                  a promise to the planner, not a merge rule, and it was untrue.
--   8. CHANGED: every function carries `set search_path = ''`. An attribute, not a behaviour:
--                                  the bodies were already fully schema-qualified.
--
-- What is deliberately NOT changed: `apply_scan_event` seeds `meta_updated_at` from the event
-- clock. That is a merge semantic, it looks wrong, and §4.12 owns it — so it is raised in the S4
-- session report and left exactly as written. See the note above that function.
--
-- Applied by `supabase db push` (remote) and by `supabase start` / `supabase db reset` (local).
-- Exercised by supabase/tests/; see supabase/README.md for how to run them.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table public.vehicles (
  user_id          uuid not null references auth.users(id) on delete cascade,
  vin              text not null check (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  unit             text,
  notes            text,
  meta_updated_at  timestamptz not null,                 -- client clock at last unit/notes edit (LWW)
  structural       jsonb not null default '{}'::jsonb,
  decode           jsonb not null default '{}'::jsonb,   -- { status, source, fetchedAt, fields }
  first_scanned_at timestamptz,
  last_scanned_at  timestamptz,
  scan_count       integer not null default 0,
  deleted_at       timestamptz,
  updated_at       timestamptz not null default now(),   -- server clock; the pull cursor
  primary key (user_id, vin)
);

-- Serves the §4.12 pull query `vehicles where updated_at >= cursor` ordered and paged at 500:
-- RLS adds `user_id = auth.uid()` to every such query, so the leading column is always bound
-- even though the client never writes it. Also the index the auth.users cascade needs to find
-- this table's referencing rows — an unindexed FK column makes deleting an account a seq scan.
create index vehicles_user_updated on public.vehicles (user_id, updated_at);

create table public.scan_events (
  id                 uuid primary key,                   -- client-generated; makes pushes idempotent
  user_id            uuid not null references auth.users(id) on delete cascade,
  vin                text not null,
  at                 timestamptz not null,
  symbology          text not null,
  check_digit_valid  boolean not null,
  device_label       text,
  origin             text not null,
  inserted_at        timestamptz not null default now(), -- server clock; the pull cursor
  -- ADDED. Same §4.1 grammar the skeleton puts on vehicles.vin. Without it a malformed VIN is
  -- refused one table later, by the vehicles insert inside `apply_scan_event`, where the error
  -- names the wrong table. `symbology` and `origin` carry no check: §4.10 locks Symbology, but
  -- the value domain of an *event's* `origin` is not pinned anywhere in §4.12 or §5.2, and a
  -- guess here would reject pushes the client is entitled to make.
  constraint scan_events_vin_grammar check (vin ~ '^[A-HJ-NPR-Z0-9]{17}$')
);

-- Serves `scan_events where inserted_at >= cursor` (§4.12 pull), plus the FK cascade above.
create index scan_events_user_inserted on public.scan_events (user_id, inserted_at);

-- ADDED. `scan_events_recount` re-derives count/min/max for one (user_id, vin) after a delete;
-- that aggregate has no other index to sit on, and `at` is carried so the recount is answered
-- from the index instead of the heap.
create index scan_events_user_vin on public.scan_events (user_id, vin, at);

-- ---------------------------------------------------------------------------------------------
-- Row level security (P8 — RLS is the wall)
-- ---------------------------------------------------------------------------------------------

alter table public.vehicles    enable row level security;
alter table public.scan_events enable row level security;
create policy own_vehicles on public.vehicles    for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_events   on public.scan_events for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Signed out, `auth.uid()` is null, `user_id = null` is null, and null is not true: every policy
-- above already denies `anon`. The revoke means a future policy written `to public` still cannot
-- expose these tables to an unauthenticated caller — the privilege is simply not there.
-- Not `force row level security`: the owner (`postgres`) bypasses RLS by design, which is what
-- lets `supabase db reset`, seeds and the tests in supabase/tests/ set rows up at all, and the
-- app never connects as the owner. `service_role` keeps its grants but reaches Postgres only
-- through the delete-account Edge Function (CLAUDE.md rule 12).
revoke all on public.vehicles    from anon;
revoke all on public.scan_events from anon;
-- Revoke first, then grant back the four verbs PostgREST actually issues. The one being taken
-- away is TRUNCATE, which row-level security does not apply to at all: a signed-in role holding
-- it could empty both tables for every account at once. Supabase's default privileges hand
-- `all` to `authenticated` on new tables in `public`, so this is not hypothetical.
revoke all on public.vehicles    from authenticated;
revoke all on public.scan_events from authenticated;
grant select, insert, update, delete on public.vehicles    to authenticated;
grant select, insert, update, delete on public.scan_events to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Server clock (the pull cursor)
-- ---------------------------------------------------------------------------------------------

-- `set search_path = ''` on every function below: with no schema search path, an unqualified
-- name cannot be captured by an object planted in another schema. Every reference in these
-- bodies is already schema-qualified (built-ins live in pg_catalog, which is always searched),
-- so this changes nothing but what an attacker could reach.
create or replace function public.touch_updated_at() returns trigger language plpgsql
  set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger vehicles_touch before update on public.vehicles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Events are the truth; the vehicles row is created/aggregated from them (P8)
-- ---------------------------------------------------------------------------------------------

-- Idempotency (§4.12 client protocol) lives in the push, not here: `upsert(rows, { onConflict:
-- "id", ignoreDuplicates: true })` compiles to `on conflict do nothing`, and a row that is not
-- inserted does not fire this trigger, so re-pushing a batch cannot double-count.
--
-- `least`/`greatest` in Postgres ignore nulls rather than propagating them, so a vehicles row
-- created by `upsert_vehicle_meta` (null first/last_scanned_at) takes the event's timestamps on
-- the first scan instead of staying null.
--
-- NOTE (raised in the S4 session report, left literal here): `meta_updated_at` is seeded from
-- the event clock, as the skeleton has it, even though the column is "client clock at last
-- unit/notes edit" and a scan is not an edit. A unit typed on device A at 10:01 loses to a scan
-- of the same VIN by device B at 12:00 when A pushes late. The client seeds its own
-- `metaUpdatedAt` at the epoch for exactly this reason (S3 report, D11). §4.12 is authoritative
-- for merge semantics, so the fix is Zach's to approve, not this file's to take.
create or replace function public.apply_scan_event() returns trigger language plpgsql
  set search_path = '' as $$
begin
  insert into public.vehicles (user_id, vin, meta_updated_at, first_scanned_at, last_scanned_at, scan_count)
  values (new.user_id, new.vin, new.at, new.at, new.at, 1)
  on conflict (user_id, vin) do update set
    first_scanned_at = least(vehicles.first_scanned_at, excluded.first_scanned_at),
    last_scanned_at  = greatest(vehicles.last_scanned_at, excluded.last_scanned_at),
    scan_count       = vehicles.scan_count + 1,
    deleted_at       = null;
  return new;
end $$;
create trigger scan_events_apply after insert on public.scan_events
  for each row execute function public.apply_scan_event();

-- ADDED. The counterpart to `apply_scan_event`. `scan_count` is "number of events" (§4.12 merge
-- rules) and `apply_scan_event` only ever adds; `delete_my_data` and the auth.users cascade both
-- delete events, and without this the row would keep claiming scans that no longer exist — which
-- other devices would then pull as fact (N2). Statement-level with a transition table so
-- deleting ten thousand events costs one aggregate, not ten thousand.
--
-- A vehicle whose last event is gone stays, with `scan_count = 0` and null timestamps: it may
-- still hold unit, notes and decode, and `upsert_vehicle_meta` creates rows in exactly that
-- shape anyway. `vehicles_touch` bumps `updated_at`, so the correction reaches other devices.
create or replace function public.recount_scan_events() returns trigger language plpgsql
  set search_path = '' as $$
begin
  update public.vehicles v set
    scan_count       = agg.n,
    first_scanned_at = agg.first_at,
    last_scanned_at  = agg.last_at
  from (
    select d.user_id,
           d.vin,
           count(e.id) as n,
           min(e.at)   as first_at,
           max(e.at)   as last_at
      from (select distinct user_id, vin from deleted_events) d
      left join public.scan_events e on e.user_id = d.user_id and e.vin = d.vin
     group by d.user_id, d.vin
  ) agg
  where v.user_id = agg.user_id and v.vin = agg.vin
    and (v.scan_count, v.first_scanned_at, v.last_scanned_at)
        is distinct from (agg.n::integer, agg.first_at, agg.last_at);
  return null;
end $$;
create trigger scan_events_recount after delete on public.scan_events
  referencing old table as deleted_events
  for each statement execute function public.recount_scan_events();

-- ADDED. P8: `scan_events` is append-only. The push only ever inserts (`on conflict do nothing`),
-- so this never fires in the protocol; it exists so that an update which *would* desync every
-- aggregate derived from the log fails loudly (P7) instead of corrupting the row silently.
create or replace function public.scan_events_immutable() returns trigger language plpgsql
  set search_path = '' as $$
begin
  raise exception 'scan_events is append-only (P8); update rejected for id %', old.id
    using errcode = '23514';
end $$;
create trigger scan_events_append_only before update on public.scan_events
  for each row execute function public.scan_events_immutable();

-- ---------------------------------------------------------------------------------------------
-- Merge helpers (§4.12 merge rules — identical on server and client)
-- ---------------------------------------------------------------------------------------------

-- Genuinely immutable: `->>` is immutable and the ranking is a closed set of literals.
create or replace function public.decode_rank(d jsonb) returns int language sql immutable
  set search_path = '' as $$
  select case d->>'status' when 'ok' then 3 when 'partial' then 2 when 'unsupported' then 1 else 0 end $$;

-- STABLE, not IMMUTABLE — corrected because the marking is a promise to the planner rather than
-- a merge rule, and the promise was false. `text::timestamptz` is stable (`timestamptz_in` is
-- declared `s`): it reads the TimeZone GUC for an offset-less string, so the same argument gives
-- 12:00+00 in one session and 12:00-07 in another, and it accepts 'now', which is the clock.
-- Declaring that immutable lets the planner fold a result and keep it, and would silently
-- corrupt any index or materialized view built over it later. Which decode wins is unchanged.
create or replace function public.better_decode(a jsonb, b jsonb) returns jsonb language sql stable
  set search_path = '' as $$
  select case
    when public.decode_rank(b) > public.decode_rank(a) then b
    when public.decode_rank(b) = public.decode_rank(a)
     and coalesce((b->>'fetchedAt')::timestamptz, '-infinity') > coalesce((a->>'fetchedAt')::timestamptz, '-infinity') then b
    else a end $$;

-- ---------------------------------------------------------------------------------------------
-- RPCs called by the outbox (§4.12 client protocol)
-- ---------------------------------------------------------------------------------------------

-- `security invoker` is right and deliberate for all three functions below: they touch only the
-- caller's own rows, so they need no elevation, and running them under the caller keeps RLS —
-- not the WHERE clause — as the thing that decides what is reachable (P8). A `security definer`
-- version would run as the owner, who bypasses RLS, and then a single mistyped predicate would
-- expose every user's rows. There is no `security definer` function in this schema.
--
-- RLS admits this insert: the row is proposed with `user_id = auth.uid()`, which is exactly
-- `own_vehicles`' WITH CHECK. The DO UPDATE path additionally needs the conflicting row to pass
-- the policy's USING clause — it does, because the conflict target is the primary key
-- (user_id, vin) and user_id is auth.uid(), so the only row this can ever collide with is the
-- caller's own. Signed out, `auth.uid()` is null and the insert fails on the not-null user_id.
create or replace function public.upsert_vehicle_meta(
  p_vin text, p_unit text, p_notes text, p_meta_updated_at timestamptz, p_structural jsonb, p_decode jsonb
) returns void language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.vehicles (user_id, vin, unit, notes, meta_updated_at, structural, decode)
  values (auth.uid(), p_vin, p_unit, p_notes, p_meta_updated_at, coalesce(p_structural, '{}'), coalesce(p_decode, '{}'))
  on conflict (user_id, vin) do update set
    unit            = case when excluded.meta_updated_at > vehicles.meta_updated_at then excluded.unit  else vehicles.unit  end,
    notes           = case when excluded.meta_updated_at > vehicles.meta_updated_at then excluded.notes else vehicles.notes end,
    meta_updated_at = greatest(vehicles.meta_updated_at, excluded.meta_updated_at),
    structural      = case when vehicles.structural = '{}'::jsonb then excluded.structural else vehicles.structural end,
    decode          = public.better_decode(vehicles.decode, excluded.decode);
end $$;

create or replace function public.delete_vehicle(p_vin text) returns void language sql security invoker
  set search_path = '' as $$
  update public.vehicles set deleted_at = now() where user_id = auth.uid() and vin = p_vin $$;

create or replace function public.delete_my_data() returns void language sql security invoker
  set search_path = '' as $$
  delete from public.scan_events where user_id = auth.uid();
  delete from public.vehicles    where user_id = auth.uid(); $$;

-- Only a signed-in caller has any business calling these. `public` holds EXECUTE on a new
-- function by default, which would hand `anon` a call it can only fail; take it back and grant
-- the roles that use it. The trigger functions above need no grant — a trigger's EXECUTE right
-- is checked when the trigger is created, not when it fires.
revoke all on function public.upsert_vehicle_meta(text, text, text, timestamptz, jsonb, jsonb) from public;
revoke all on function public.delete_vehicle(text) from public;
revoke all on function public.delete_my_data() from public;
grant execute on function public.upsert_vehicle_meta(text, text, text, timestamptz, jsonb, jsonb) to authenticated;
grant execute on function public.delete_vehicle(text) to authenticated;
grant execute on function public.delete_my_data() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Realtime (§4.12: `postgres_changes` on `vehicles`, filtered user_id=eq.<uid>)
-- ---------------------------------------------------------------------------------------------

-- The event is only a signal to pull (§4.12), so `vehicles` alone is published: a scan on
-- another device already updates its vehicles row through `apply_scan_event`.
-- Default replica identity (the primary key) is enough — user_id is part of that key, so the
-- subscription filter still resolves on every payload; `replica identity full` would double the
-- WAL for old-row values nothing reads. Guarded rather than bare so that this migration also
-- applies to a plain Postgres — the RLS tests in supabase/tests/ run there — where the
-- supabase_realtime publication does not exist.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    raise notice 'publication supabase_realtime not found; skipping realtime for public.vehicles';
  elsif not exists (
    select 1 from pg_catalog.pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'vehicles'
  ) then
    alter publication supabase_realtime add table public.vehicles;
  end if;
-- Altering a publication needs ownership of it, and who owns supabase_realtime is the platform's
-- business, not this file's. Realtime is only a signal to pull (§4.12) — the 5-minute, on-visible
-- and post-push pulls still deliver everything without it — so a refusal here degrades sync
-- latency rather than the migration. Failing `db push` on the last statement, and rolling the
-- whole schema back with it, would be the worse trade. supabase/README.md says to confirm the
-- publication in the dashboard for exactly this reason.
exception when insufficient_privilege or wrong_object_type then
  raise notice 'could not add public.vehicles to supabase_realtime (%); realtime will be silent', sqlerrm;
end $$;
