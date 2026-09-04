-- §9-S4 DoD: "a second test user cannot read or write the first user's rows (RLS test in CI)".
--
-- Two users, A and B. Everything B tries against A's rows must fail — silently (zero rows, the
-- row is not there to be seen) or loudly (42501, the write is refused). The test also asserts
-- the shape of the posture itself: RLS on every table, a policy on every table, no
-- `security definer` function anywhere in `public`.
--
-- Run it with supabase/tests/run.sh, or:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/10_rls_test.sql "$DATABASE_URL"
-- The whole file is one transaction that ends in ROLLBACK, so it leaves the database as it
-- found it and can be run repeatedly against a live dev project.
--
-- How a test "is" a user: PostgREST sets the connection role to `authenticated` and puts the
-- verified JWT claims in `request.jwt.claims`; `auth.uid()` reads `sub` out of them. Doing the
-- same two SETs here exercises the same code path as a real request. It proves nothing about
-- whether GoTrue would have issued that JWT — see the S4 session report.

\set ON_ERROR_STOP on
-- Void-returning RPC calls below would otherwise each print an empty result table.
\pset tuples_only on

\set uid_a '11111111-1111-4111-8111-111111111111'
\set uid_b '22222222-2222-4222-8222-222222222222'
\set vin_a '1HGCM82633A004352'
\set vin_b '1FUJGLDR49SAV1234'

begin;

create function public.t_assert(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is distinct from true then
    raise exception 'ASSERT FAILED: %', msg;
  end if;
end $$;
grant execute on function public.t_assert(boolean, text) to public;

-- ---------------------------------------------------------------------------------------------
-- Posture assertions — these hold for the schema, not for a particular row
-- ---------------------------------------------------------------------------------------------

do $$
declare bad text;
begin
  select string_agg(c.relname, ', ')
    into bad
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  perform public.t_assert(bad is null, format('tables in public without RLS enabled: %s', bad));

  select string_agg(c.relname, ', ')
    into bad
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = c.oid);
  perform public.t_assert(bad is null, format('tables in public with RLS but no policy: %s', bad));

  -- CLAUDE.md rule 12 / §4.12: the wall is RLS, so nothing may run as the owner and step over it.
  select string_agg(p.proname, ', ')
    into bad
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef;
  perform public.t_assert(bad is null, format('security definer functions in public: %s', bad));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Fixtures (as the owner: only the owner may write auth.users)
-- ---------------------------------------------------------------------------------------------

insert into auth.users (id, email) values
  (:'uid_a', 'a@example.test'),
  (:'uid_b', 'b@example.test');

-- ---------------------------------------------------------------------------------------------
-- User A writes its own rows through the ordinary client path
-- ---------------------------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';

insert into public.scan_events (id, user_id, vin, at, symbology, check_digit_valid, device_label, origin)
values ('aaaaaaaa-0000-4000-8000-000000000001', :'uid_a', :'vin_a',
        '2026-09-01T08:00:00-07:00', 'code_39', true, 'A phone', 'scan');
select public.upsert_vehicle_meta(:'vin_a', 'UNIT-A', 'notes from A',
       '2026-09-01T09:00:00-07:00', '{"wmi":"1HG"}'::jsonb, '{"status":"ok","fetchedAt":"2026-09-01T09:00:00-07:00"}'::jsonb);

do $$
begin
  perform public.t_assert(
    (select count(*) from public.vehicles where vin = '1HGCM82633A004352') = 1,
    'A cannot see the vehicles row its own scan event created');
  perform public.t_assert(
    (select unit from public.vehicles where vin = '1HGCM82633A004352') = 'UNIT-A',
    'A cannot read back the unit it just wrote');
end $$;

-- ---------------------------------------------------------------------------------------------
-- User B: every read of A's rows comes back empty
-- ---------------------------------------------------------------------------------------------

set local request.jwt.claims = '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}';

do $$
begin
  perform public.t_assert((select count(*) from public.vehicles) = 0,
    'B can read A''s vehicles rows');
  perform public.t_assert((select count(*) from public.scan_events) = 0,
    'B can read A''s scan_events rows');
  perform public.t_assert(
    (select count(*) from public.vehicles where user_id = '11111111-1111-4111-8111-111111111111'::uuid) = 0,
    'B can read A''s vehicles rows by naming A''s user_id');
end $$;

-- ---------------------------------------------------------------------------------------------
-- User B: every write against A's rows is refused
-- ---------------------------------------------------------------------------------------------

do $$
declare touched integer;
begin
  -- Direct insert of a row owned by A — refused by the WITH CHECK on own_vehicles.
  begin
    insert into public.vehicles (user_id, vin, meta_updated_at)
    values ('11111111-1111-4111-8111-111111111111'::uuid, '1HGCM826X3A004350', now());
    raise exception 'ASSERT FAILED: B inserted a vehicles row owned by A';
  exception when insufficient_privilege then null;
  end;

  -- Same for the event log, which is where a forged row would do the most damage: the insert
  -- trigger would otherwise write into A's aggregates.
  begin
    insert into public.scan_events (id, user_id, vin, at, symbology, check_digit_valid, origin)
    values ('bbbbbbbb-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111'::uuid,
            '1HGCM82633A004352', now(), 'code_39', true, 'scan');
    raise exception 'ASSERT FAILED: B inserted a scan_event owned by A';
  exception when insufficient_privilege then null;
  end;

  -- Updates and deletes do not error: A's rows are simply not visible, so nothing matches.
  update public.vehicles set unit = 'STOLEN' where vin = '1HGCM82633A004352';
  get diagnostics touched = row_count;
  perform public.t_assert(touched = 0, 'B updated A''s vehicles row');

  delete from public.scan_events where vin = '1HGCM82633A004352';
  get diagnostics touched = row_count;
  perform public.t_assert(touched = 0, 'B deleted A''s scan_events');

  delete from public.vehicles where vin = '1HGCM82633A004352';
  get diagnostics touched = row_count;
  perform public.t_assert(touched = 0, 'B deleted A''s vehicles row');
end $$;

-- B cannot hand its own row to A either: WITH CHECK is evaluated on the row as updated, so a
-- user_id rewrite is refused rather than becoming a way to write into another account.
insert into public.scan_events (id, user_id, vin, at, symbology, check_digit_valid, origin)
values ('bbbbbbbb-0000-4000-8000-000000000002', :'uid_b', :'vin_b',
        '2026-09-02T08:00:00-07:00', 'code_128', true, 'scan');

do $$
begin
  begin
    update public.vehicles set user_id = '11111111-1111-4111-8111-111111111111'::uuid
     where vin = '1FUJGLDR49SAV1234';
    raise exception 'ASSERT FAILED: B reassigned its own row to A';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ---------------------------------------------------------------------------------------------
-- User B: the RPCs are bounded by the same wall
-- ---------------------------------------------------------------------------------------------

select public.delete_vehicle(:'vin_a');
select public.upsert_vehicle_meta(:'vin_a', 'UNIT-B', 'B was here',
       '2030-01-01T00:00:00Z', '{"wmi":"XXX"}'::jsonb, '{"status":"ok","fetchedAt":"2030-01-01T00:00:00Z"}'::jsonb);
select public.delete_my_data();

set local request.jwt.claims = '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';

do $$
declare v public.vehicles%rowtype;
begin
  select * into v from public.vehicles where vin = '1HGCM82633A004352';
  perform public.t_assert(v.user_id = '11111111-1111-4111-8111-111111111111'::uuid,
    'A''s row is gone after B''s RPC calls');
  perform public.t_assert(v.deleted_at is null,
    'B''s delete_vehicle soft-deleted A''s row');
  perform public.t_assert(v.unit = 'UNIT-A',
    'B''s upsert_vehicle_meta overwrote A''s unit — got ' || coalesce(v.unit, '<null>'));
  perform public.t_assert(v.notes = 'notes from A',
    'B''s upsert_vehicle_meta overwrote A''s notes');
  perform public.t_assert(v.structural = '{"wmi":"1HG"}'::jsonb,
    'B''s upsert_vehicle_meta overwrote A''s structural block');
  -- B's own upsert wrote a row under B's user_id and B's delete_my_data then removed it;
  -- either way A must still have exactly one event.
  perform public.t_assert((select count(*) from public.scan_events) = 1,
    'B''s delete_my_data took A''s events with it');
end $$;

-- ---------------------------------------------------------------------------------------------
-- Signed out: the anon role reaches nothing
-- ---------------------------------------------------------------------------------------------

-- Two acceptable answers, and the test accepts either: 42501 because the migration revokes the
-- table privileges from anon, or zero rows because `user_id = auth.uid()` is null-null and never
-- true. The failure this catches is a third one — rows.
set local role anon;
set local request.jwt.claims = '';

do $$
declare n integer;
begin
  begin
    select count(*) into n from public.vehicles;
    perform public.t_assert(n = 0, 'anon read vehicles rows');
  exception when insufficient_privilege then null;
  end;

  begin
    select count(*) into n from public.scan_events;
    perform public.t_assert(n = 0, 'anon read scan_events rows');
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.scan_events (id, user_id, vin, at, symbology, check_digit_valid, origin)
    values ('cccccccc-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111'::uuid,
            '1HGCM82633A004352', now(), 'code_39', true, 'scan');
    raise exception 'ASSERT FAILED: anon inserted a scan_event';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.upsert_vehicle_meta('1HGCM82633A004352', 'anon', null, now(), '{}'::jsonb, '{}'::jsonb);
    raise exception 'ASSERT FAILED: anon called upsert_vehicle_meta';
  exception
    when insufficient_privilege then null;  -- EXECUTE revoked from public
    when not_null_violation then null;      -- or auth.uid() is null and user_id refuses it
  end;
end $$;

reset role;

rollback;

\echo 'RLS TEST PASSED'
