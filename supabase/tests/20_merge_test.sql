-- §4.12 merge rules, exercised server-side against the real triggers and RPCs. The client
-- implements the same rules over Dexie (§4.12: "identical on server and client"); this file is
-- the server half of that pair, and every assertion below is quoted from the rule it pins.
--
-- Run it with supabase/tests/run.sh, or:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/20_merge_test.sql "$DATABASE_URL"
-- One transaction, ROLLBACK at the end: safe to run against a live dev project.
--
-- Everything runs as `authenticated` rather than as the owner, so each statement also passes
-- through RLS on its way to the assertion — a merge rule that only works with the wall switched
-- off is not a merge rule that ships.

\set ON_ERROR_STOP on
-- Void-returning RPC calls below would otherwise each print an empty result table.
\pset tuples_only on

\set uid_c '33333333-3333-4333-8333-333333333333'
\set uid_d '44444444-4444-4444-8444-444444444444'
\set vin   '1HGCM82633A004352'

begin;

create function public.t_assert(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is distinct from true then
    raise exception 'ASSERT FAILED: %', msg;
  end if;
end $$;
grant execute on function public.t_assert(boolean, text) to public;

insert into auth.users (id, email) values (:'uid_c', 'c@example.test'), (:'uid_d', 'd@example.test');

set local role authenticated;
set local request.jwt.claims = '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}';

-- ---------------------------------------------------------------------------------------------
-- Pure merge helpers (§4.12: rank ok 3 > partial 2 > unsupported 1 > pending/failed 0)
-- ---------------------------------------------------------------------------------------------

do $$
begin
  perform public.t_assert(public.decode_rank('{"status":"ok"}') = 3, 'rank(ok) <> 3');
  perform public.t_assert(public.decode_rank('{"status":"partial"}') = 2, 'rank(partial) <> 2');
  perform public.t_assert(public.decode_rank('{"status":"unsupported"}') = 1, 'rank(unsupported) <> 1');
  perform public.t_assert(public.decode_rank('{"status":"pending"}') = 0, 'rank(pending) <> 0');
  perform public.t_assert(public.decode_rank('{"status":"failed"}') = 0, 'rank(failed) <> 0');
  perform public.t_assert(public.decode_rank('{}') = 0, 'rank(no status) <> 0');

  perform public.t_assert(
    public.better_decode('{"status":"partial"}', '{"status":"ok"}') = '{"status":"ok"}'::jsonb,
    'higher rank did not win');
  perform public.t_assert(
    public.better_decode('{"status":"ok"}', '{"status":"partial"}') = '{"status":"ok"}'::jsonb,
    'lower rank displaced a higher one');
  -- Equal rank falls back to fetchedAt; a decode with no fetchedAt is treated as -infinity, so
  -- the incoming row only wins when it is genuinely newer. Ties keep what is already there.
  perform public.t_assert(
    public.better_decode('{"status":"ok","fetchedAt":"2026-09-01T00:00:00Z"}',
                         '{"status":"ok","fetchedAt":"2026-09-02T00:00:00Z"}') ->> 'fetchedAt'
      = '2026-09-02T00:00:00Z',
    'newer fetchedAt did not win at equal rank');
  perform public.t_assert(
    public.better_decode('{"status":"ok","fetchedAt":"2026-09-02T00:00:00Z"}',
                         '{"status":"ok","fetchedAt":"2026-09-01T00:00:00Z"}') ->> 'fetchedAt'
      = '2026-09-02T00:00:00Z',
    'older fetchedAt displaced a newer one at equal rank');
  perform public.t_assert(
    public.better_decode('{"status":"ok","fetchedAt":"2026-09-01T00:00:00Z"}',
                         '{"status":"ok","fetchedAt":"2026-09-01T00:00:00Z"}') ->> 'fetchedAt'
      = '2026-09-01T00:00:00Z',
    'a tie did not keep the existing value');
  perform public.t_assert(
    public.better_decode('{"status":"ok","fetchedAt":"2026-09-01T00:00:00Z"}', '{"status":"ok"}')
      ->> 'fetchedAt' = '2026-09-01T00:00:00Z',
    'a decode with no fetchedAt displaced one that has it');
end $$;

-- ---------------------------------------------------------------------------------------------
-- Events are the truth: the vehicles row is created and aggregated from them (P8)
-- ---------------------------------------------------------------------------------------------

insert into public.scan_events (id, user_id, vin, at, symbology, check_digit_valid, device_label, origin)
values ('cccccccc-0000-4000-8000-000000000001', :'uid_c', :'vin',
        '2026-09-01T08:00:00-07:00', 'code_39', true, 'C phone', 'scan');

do $$
declare v public.vehicles%rowtype;
begin
  select * into v from public.vehicles where vin = '1HGCM82633A004352';
  perform public.t_assert(v.scan_count = 1, 'first event did not create scan_count 1');
  perform public.t_assert(v.first_scanned_at = '2026-09-01T08:00:00-07:00'::timestamptz, 'first_scanned_at wrong');
  perform public.t_assert(v.last_scanned_at  = '2026-09-01T08:00:00-07:00'::timestamptz, 'last_scanned_at wrong');
  perform public.t_assert(v.deleted_at is null, 'new row arrived soft-deleted');
  perform public.t_assert(v.structural = '{}'::jsonb and v.decode = '{}'::jsonb, 'jsonb defaults wrong');
end $$;

-- Later scan: count up, last moves, first holds.
insert into public.scan_events (id, user_id, vin, at, symbology, check_digit_valid, origin)
values ('cccccccc-0000-4000-8000-000000000002', :'uid_c', :'vin',
        '2026-09-02T09:30:00-07:00', 'code_128', true, 'scan');

-- Out of order (an offline device pushing an older scan): first moves back, last holds.
insert into public.scan_events (id, user_id, vin, at, symbology, check_digit_valid, origin)
values ('cccccccc-0000-4000-8000-000000000003', :'uid_c', :'vin',
        '2026-08-30T06:00:00-07:00', 'qr_code', false, 'import');

do $$
declare v public.vehicles%rowtype;
begin
  select * into v from public.vehicles where vin = '1HGCM82633A004352';
  perform public.t_assert(v.scan_count = 3, 'scan_count is not the number of events');
  perform public.t_assert(v.first_scanned_at = '2026-08-30T06:00:00-07:00'::timestamptz,
    'an out-of-order event did not move first_scanned_at back');
  perform public.t_assert(v.last_scanned_at = '2026-09-02T09:30:00-07:00'::timestamptz,
    'an out-of-order event moved last_scanned_at back');
end $$;

-- Idempotent push (§4.12: upsert onConflict id, ignoreDuplicates). The re-sent row is not
-- inserted, so the AFTER INSERT trigger never fires and the count cannot drift. This is the
-- whole reason the id is generated on the client.
insert into public.scan_events (id, user_id, vin, at, symbology, check_digit_valid, origin)
values ('cccccccc-0000-4000-8000-000000000001', :'uid_c', :'vin',
        '2026-09-01T08:00:00-07:00', 'code_39', true, 'scan')
on conflict (id) do nothing;

do $$
begin
  perform public.t_assert(
    (select scan_count from public.vehicles where vin = '1HGCM82633A004352') = 3,
    're-pushing an event double-counted it');
  perform public.t_assert((select count(*) from public.scan_events) = 3, 'the event log grew on a re-push');
end $$;

-- ---------------------------------------------------------------------------------------------
-- unit / notes: last-writer-wins by meta_updated_at; ties keep the existing value
-- ---------------------------------------------------------------------------------------------

select public.upsert_vehicle_meta(:'vin', 'UNIT-1', 'first note', '2026-09-05T12:00:00-07:00',
       '{"wmi":"1HG"}'::jsonb, '{"status":"partial","fetchedAt":"2026-09-05T12:00:00-07:00"}'::jsonb);

do $$
declare v public.vehicles%rowtype;
begin
  select * into v from public.vehicles where vin = '1HGCM82633A004352';
  perform public.t_assert(v.unit = 'UNIT-1' and v.notes = 'first note', 'the first edit did not land');
  perform public.t_assert(v.structural = '{"wmi":"1HG"}'::jsonb,
    'structural did not take the first non-empty value');
  perform public.t_assert(v.decode ->> 'status' = 'partial', 'decode did not take the first non-empty value');
  perform public.t_assert(v.scan_count = 3, 'a meta upsert changed a derived aggregate');
end $$;

-- An older edit loses.
select public.upsert_vehicle_meta(:'vin', 'UNIT-STALE', 'stale note', '2026-09-04T12:00:00-07:00',
       '{"wmi":"ZZZ"}'::jsonb, '{"status":"failed"}'::jsonb);
-- A tie keeps what is there.
select public.upsert_vehicle_meta(:'vin', 'UNIT-TIE', 'tie note', '2026-09-05T12:00:00-07:00',
       null, null);

do $$
declare v public.vehicles%rowtype;
begin
  select * into v from public.vehicles where vin = '1HGCM82633A004352';
  perform public.t_assert(v.unit = 'UNIT-1', 'an older or tied edit overwrote the unit: ' || coalesce(v.unit, '<null>'));
  perform public.t_assert(v.notes = 'first note', 'an older or tied edit overwrote the notes');
  perform public.t_assert(v.meta_updated_at = '2026-09-05T12:00:00-07:00'::timestamptz,
    'meta_updated_at is not the greatest of the two clocks');
  -- §4.12: structural is first-non-empty-wins, so a second, different block never displaces it.
  perform public.t_assert(v.structural = '{"wmi":"1HG"}'::jsonb, 'structural was overwritten');
  -- And a lower-ranked decode never displaces a higher one, whatever the meta clock says.
  perform public.t_assert(v.decode ->> 'status' = 'partial', 'a failed decode displaced a partial one');
end $$;

-- A newer edit wins, and carries a better decode with it.
select public.upsert_vehicle_meta(:'vin', 'UNIT-2', 'second note', '2026-09-06T12:00:00-07:00',
       null, '{"status":"ok","fetchedAt":"2026-09-06T12:00:00-07:00"}'::jsonb);

do $$
declare v public.vehicles%rowtype;
begin
  select * into v from public.vehicles where vin = '1HGCM82633A004352';
  perform public.t_assert(v.unit = 'UNIT-2' and v.notes = 'second note', 'the newer edit did not win');
  perform public.t_assert(v.decode ->> 'status' = 'ok', 'ok did not displace partial');
end $$;

-- ---------------------------------------------------------------------------------------------
-- The other order: an edit reaches the server before any event does
-- ---------------------------------------------------------------------------------------------

-- `upsert_vehicle_meta` creates the row with scan_count 0 and no timestamps. The first event
-- then has to fill them in through `least`/`greatest`, which in Postgres ignore nulls instead of
-- propagating them — if they behaved like most other databases, this row would keep null
-- first/last_scanned_at forever and History would have nothing to sort by.
select public.upsert_vehicle_meta('1HGCM826X3A004350', 'UNIT-META-FIRST', null,
       '2026-09-07T12:00:00-07:00', '{"wmi":"1HG"}'::jsonb, '{"status":"pending"}'::jsonb);

do $$
declare v public.vehicles%rowtype;
begin
  select * into v from public.vehicles where vin = '1HGCM826X3A004350';
  perform public.t_assert(v.scan_count = 0, 'a meta-only row did not start at scan_count 0');
  perform public.t_assert(v.first_scanned_at is null and v.last_scanned_at is null,
    'a meta-only row invented scan timestamps');
end $$;

insert into public.scan_events (id, user_id, vin, at, symbology, check_digit_valid, origin)
values ('cccccccc-0000-4000-8000-000000000006', :'uid_c', '1HGCM826X3A004350',
        '2026-09-08T08:00:00-07:00', 'data_matrix', true, 'scan');

do $$
declare v public.vehicles%rowtype;
begin
  select * into v from public.vehicles where vin = '1HGCM826X3A004350';
  perform public.t_assert(v.scan_count = 1, 'the first event on a meta-only row did not count');
  perform public.t_assert(v.first_scanned_at = '2026-09-08T08:00:00-07:00'::timestamptz
                      and v.last_scanned_at  = '2026-09-08T08:00:00-07:00'::timestamptz,
    'least/greatest against nulls left the scan timestamps null');
  perform public.t_assert(v.unit = 'UNIT-META-FIRST', 'the event wiped the meta already on the row');
  perform public.t_assert(v.meta_updated_at = '2026-09-07T12:00:00-07:00'::timestamptz,
    'a scan moved the meta clock on an existing row');
end $$;

-- §4.1 grammar, enforced on the event log as well as on vehicles (added to the skeleton).
do $$
begin
  begin
    insert into public.scan_events (id, user_id, vin, at, symbology, check_digit_valid, origin)
    values ('cccccccc-0000-4000-8000-000000000009', '33333333-3333-4333-8333-333333333333'::uuid,
            '1HGCM8263IA004352', now(), 'code_39', true, 'scan');
    raise exception 'ASSERT FAILED: an event carrying I/O/Q was accepted';
  exception when check_violation then null;
  end;
end $$;

-- ---------------------------------------------------------------------------------------------
-- The meta clock a scan leaves behind (§4.12: it moves only on a unit or notes edit)
-- ---------------------------------------------------------------------------------------------

-- `apply_scan_event` seeds meta_updated_at at the never-edited sentinel, because a scan is not
-- an edit. Both assertions below used to say the opposite: they recorded the hazard raised in
-- the S4 session report — an edit dropped by a later scan on another device — rather than the
-- rule, and they flipped when Zach approved the fix. The scenario after this one is the data
-- loss they were recording, run end to end.
--
-- The sentinel is the value the client already writes (`META_NEVER_EDITED`, src/lib/vin/types.ts,
-- S3 D11). This file is the server half of "identical on server and client", so the literal here
-- is the assertion that the two halves agree.
insert into public.scan_events (id, user_id, vin, at, symbology, check_digit_valid, origin)
values ('cccccccc-0000-4000-8000-000000000004', :'uid_c', '1FUJGLDR49SAV1234',
        '2026-09-10T12:00:00-07:00', 'code_39', true, 'scan');

do $$
declare v public.vehicles%rowtype;
begin
  select * into v from public.vehicles where vin = '1FUJGLDR49SAV1234';
  perform public.t_assert(v.meta_updated_at = '1970-01-01T00:00:00.000Z'::timestamptz,
    'a scan seeded meta_updated_at from the event clock instead of the never-edited sentinel');
  perform public.t_assert(v.unit is null and v.notes is null, 'a scan invented unit or notes');
end $$;

-- So an edit older than the scan that created the row still wins: the sentinel is older than
-- any real client clock, and losing to it is the one comparison an edit can never lose.
select public.upsert_vehicle_meta('1FUJGLDR49SAV1234', 'UNIT-EARLIER', 'typed before that scan',
       '2026-09-09T12:00:00-07:00', null, null);

do $$
declare v public.vehicles%rowtype;
begin
  select * into v from public.vehicles where vin = '1FUJGLDR49SAV1234';
  perform public.t_assert(v.unit = 'UNIT-EARLIER',
    'an edit older than the scan that created the row was dropped: ' || coalesce(v.unit, '<null>'));
  perform public.t_assert(v.notes = 'typed before that scan', 'the notes on that edit were dropped');
  perform public.t_assert(v.meta_updated_at = '2026-09-09T12:00:00-07:00'::timestamptz,
    'meta_updated_at is not the clock of the first real edit');
end $$;

-- ---------------------------------------------------------------------------------------------
-- Two devices, one VIN: a typed unit survives a scan that reaches the server first
-- ---------------------------------------------------------------------------------------------

-- The scenario the seed above exists for, in arrival order. Device A types a unit at 10:01 while
-- offline. Device B scans the same VIN at 12:00 and pushes first. A comes back on signal and
-- pushes at 13:00, still carrying 10:01 — the clock is the edit's, not the push's (§4.12).
--
-- A's edit is genuinely older than B's scan and must still win, because B never edited anything.
-- With the event clock as the seed it lost twice: A's push lost the LWW comparison, and A's next
-- pull then carried the server's null unit back over the local one, so the typed value was gone
-- from every device with nothing left to report it. §4.12's client-side rule about "an unpushed
-- vehicle_meta newer than the server's meta_updated_at" cannot cover it — by the clock A's edit
-- really is older.

-- 12:00, device B: the scan reaches the server first and creates the row.
insert into public.scan_events (id, user_id, vin, at, symbology, check_digit_valid, device_label, origin)
values ('cccccccc-0000-4000-8000-000000000007', :'uid_c', '1HTMMAAL67H412345',
        '2026-09-12T12:00:00-07:00', 'code_128', true, 'B phone', 'scan');

do $$
declare v public.vehicles%rowtype;
begin
  select * into v from public.vehicles where vin = '1HTMMAAL67H412345';
  perform public.t_assert(v.meta_updated_at = '1970-01-01T00:00:00.000Z'::timestamptz,
    'B''s scan moved the meta clock to the scan time');
end $$;

-- 13:00, device A: the push of a unit typed at 10:01, before B ever saw the truck.
select public.upsert_vehicle_meta('1HTMMAAL67H412345', 'UNIT-A', null,
       '2026-09-12T10:01:00-07:00', null, null);

do $$
declare v public.vehicles%rowtype;
begin
  select * into v from public.vehicles where vin = '1HTMMAAL67H412345';
  perform public.t_assert(v.unit = 'UNIT-A',
    'the unit A typed at 10:01 lost to B''s 12:00 scan: ' || coalesce(v.unit, '<null>'));
  perform public.t_assert(v.meta_updated_at = '2026-09-12T10:01:00-07:00'::timestamptz,
    'meta_updated_at is not A''s edit clock, so A''s next pull would erase the unit locally too');
  -- The scan is still the scan: an edit never disturbs an aggregate derived from the event log.
  perform public.t_assert(
    v.scan_count = 1 and v.last_scanned_at = '2026-09-12T12:00:00-07:00'::timestamptz,
    'the meta push disturbed an aggregate derived from the event log');
end $$;

-- The other direction, which was already right and must stay right: a scan arriving after an
-- edit leaves the edit clock exactly where it is. (Asserted from the meta-first order too, on
-- '1HGCM826X3A004350' above; this is the same rule with the row created by a scan instead.)
insert into public.scan_events (id, user_id, vin, at, symbology, check_digit_valid, origin)
values ('cccccccc-0000-4000-8000-000000000008', :'uid_c', '1HTMMAAL67H412345',
        '2026-09-13T08:00:00-07:00', 'code_39', true, 'scan');

do $$
declare v public.vehicles%rowtype;
begin
  select * into v from public.vehicles where vin = '1HTMMAAL67H412345';
  perform public.t_assert(v.meta_updated_at = '2026-09-12T10:01:00-07:00'::timestamptz,
    'a later scan moved the meta clock off the edit that set it');
  perform public.t_assert(v.unit = 'UNIT-A', 'a later scan wiped the unit');
  perform public.t_assert(v.scan_count = 2, 'the later scan was not counted');
end $$;

-- ---------------------------------------------------------------------------------------------
-- Soft delete, and the scan that undoes it
-- ---------------------------------------------------------------------------------------------

-- Plant an old updated_at so the cursor can be seen to move; inside one transaction now() is
-- constant, so this is the only way to observe the touch trigger firing. `reset role` goes back
-- to the connecting user — the owner, who is not subject to the policy.
reset role;
update public.vehicles set updated_at = '2020-01-01T00:00:00Z' where vin = '1HGCM82633A004352';
set local role authenticated;

select public.delete_vehicle(:'vin');

do $$
declare v public.vehicles%rowtype;
begin
  select * into v from public.vehicles where vin = '1HGCM82633A004352';
  perform public.t_assert(v.deleted_at is not null, 'delete_vehicle did not soft-delete');
  perform public.t_assert(v.updated_at = now(),
    'the pull cursor did not move on delete — other devices would never see the tombstone');
  perform public.t_assert(v.unit = 'UNIT-2', 'a soft delete destroyed the row''s contents');
end $$;

-- §4.12: "any later scan event clears it".
insert into public.scan_events (id, user_id, vin, at, symbology, check_digit_valid, origin)
values ('cccccccc-0000-4000-8000-000000000005', :'uid_c', :'vin',
        '2026-09-11T08:00:00-07:00', 'code_39', true, 'scan');

do $$
declare v public.vehicles%rowtype;
begin
  select * into v from public.vehicles where vin = '1HGCM82633A004352';
  perform public.t_assert(v.deleted_at is null, 'a later scan did not clear deleted_at');
  perform public.t_assert(v.scan_count = 4, 'the undeleting scan was not counted');
end $$;

-- ---------------------------------------------------------------------------------------------
-- scan_count against deletes (the trigger this file adds to the skeleton)
-- ---------------------------------------------------------------------------------------------

delete from public.scan_events where id = 'cccccccc-0000-4000-8000-000000000005';

do $$
declare v public.vehicles%rowtype;
begin
  select * into v from public.vehicles where vin = '1HGCM82633A004352';
  perform public.t_assert(v.scan_count = 3, 'deleting an event left scan_count claiming it');
  perform public.t_assert(v.last_scanned_at = '2026-09-02T09:30:00-07:00'::timestamptz,
    'last_scanned_at still points at a deleted event');
  perform public.t_assert(v.first_scanned_at = '2026-08-30T06:00:00-07:00'::timestamptz,
    'first_scanned_at moved when a later event was deleted');
end $$;

delete from public.scan_events where vin = :'vin';

do $$
declare v public.vehicles%rowtype;
begin
  select * into v from public.vehicles where vin = '1HGCM82633A004352';
  perform public.t_assert(v.scan_count = 0, 'a vehicle with no events still claims scans');
  perform public.t_assert(v.first_scanned_at is null and v.last_scanned_at is null,
    'a vehicle with no events still carries scan timestamps');
  -- The row itself stays: it holds unit, notes and decode, which no event ever supplied.
  perform public.t_assert(v.unit = 'UNIT-2', 'deleting the events deleted the vehicle');
end $$;

-- ---------------------------------------------------------------------------------------------
-- The event log is append-only (P8)
-- ---------------------------------------------------------------------------------------------

do $$
begin
  begin
    update public.scan_events set at = now() where id = 'cccccccc-0000-4000-8000-000000000004';
    raise exception 'ASSERT FAILED: a scan_event was updated';
  exception when check_violation then null;
  end;
end $$;

-- ---------------------------------------------------------------------------------------------
-- delete_my_data, and the cascade behind the delete-account Edge Function
-- ---------------------------------------------------------------------------------------------

select public.delete_my_data();

do $$
begin
  perform public.t_assert((select count(*) from public.vehicles) = 0, 'delete_my_data left vehicles behind');
  perform public.t_assert((select count(*) from public.scan_events) = 0, 'delete_my_data left events behind');
end $$;

-- The Edge Function deletes the auth user and nothing else; these two FKs are what makes that
-- enough. Run as the owner because that is who the service-role key stands in for here.
reset role;

insert into public.scan_events (id, user_id, vin, at, symbology, check_digit_valid, origin)
values ('dddddddd-0000-4000-8000-000000000001', :'uid_d', :'vin',
        '2026-09-01T08:00:00-07:00', 'code_39', true, 'scan');

do $$
begin
  perform public.t_assert((select count(*) from public.vehicles where user_id = '44444444-4444-4444-8444-444444444444') = 1,
    'fixture for the cascade did not create a vehicles row');

  delete from auth.users where id = '44444444-4444-4444-8444-444444444444';

  perform public.t_assert((select count(*) from public.vehicles where user_id = '44444444-4444-4444-8444-444444444444') = 0,
    'deleting the auth user left vehicles rows behind');
  perform public.t_assert((select count(*) from public.scan_events where user_id = '44444444-4444-4444-8444-444444444444') = 0,
    'deleting the auth user left scan_events rows behind');
end $$;

reset role;

rollback;

\echo 'MERGE TEST PASSED'
