-- VIN Relay — S5, the paint code (§5.1 `paint`, §4.9 `pc`).
--
-- One nullable column and one RPC signature. Everything §4.12's skeleton names is untouched:
-- no table, column, function or policy is renamed, and the merge semantics of `unit`, `notes`,
-- `structural`, `decode`, the aggregates and the tombstone are exactly what 0001 established.
--
-- The client half of this file is `src/lib/sync/merge.ts`, which §4.12 requires to be identical
-- to the SQL. The two rules below are mirrored there line for line:
--   · `paint` is last-writer-wins by `meta_updated_at`, the same clock and the same comparison
--     `unit` and `notes` already use, so a user's own devices converge on the newest edit and a
--     tie keeps what is already stored;
--   · a scan still never moves that clock (`apply_scan_event` is unchanged), so a row that has
--     only ever been scanned cannot displace a typed paint code however recently it was seen.
--
-- Why LWW and not "first non-empty wins": clearing a wrong code has to propagate. A paint code
-- has no check digit and no grammar (§4.9, ruled 2026-09-06), so the human who cleared it is the
-- only thing that knows it was wrong — a merge that could not carry a clear would resurrect it
-- on the next pull and state it as a fact again (N2). It inherits the hazard §4.12 already
-- accepts for `unit` and `notes`: a device that edits offline without having pulled pushes the
-- record as *it* knows it, so its clock can carry a null over another device's newer value.
--
-- §5.3's "unless the user confirms overwrite" is a rule about *capture* — what a scan or an
-- import may do to a value on this phone — and it is kept on the client, where the person is.
-- Sync is the same user's own devices reconciling values that person already confirmed.
--
-- Applied by `supabase db push` (remote) and by `supabase start` / `supabase db reset` (local).

-- ---------------------------------------------------------------------------------------------
-- The column
-- ---------------------------------------------------------------------------------------------

-- Nullable, unconstrained and unindexed, for the three reasons the client field carries:
-- null is "nobody has typed one"; Toyota `1F7`, Honda `NH-731P`, Ford `UG`, VW `LC9X` and GM
-- `WA8555` share no grammar to check against, so a CHECK here would refuse a real code; and
-- nothing queries by it — the pull pages by `updated_at` and every read is by primary key.
alter table public.vehicles add column if not exists paint text;

comment on column public.vehicles.paint is
  '§4.9 pc: the paint code, captured by a human and never decoded. No check digit, no shared '
  'grammar, and NHTSA does not publish it, so nothing downstream can detect a wrong one.';

-- ---------------------------------------------------------------------------------------------
-- The RPC (§4.12 locked name: `upsert_vehicle_meta`)
-- ---------------------------------------------------------------------------------------------

-- `create or replace` cannot add a parameter: a different argument list makes a *new* function,
-- and Postgres would then have two candidates for a six-argument call and refuse it as
-- ambiguous. So the six-argument signature is dropped and the seven-argument one created.
--
-- `p_paint` carries a default for the one caller this cannot be coordinated with: an app build
-- from before S5, still installed on somebody's phone, pushing its queued rows. PostgREST
-- resolves `rpc()` arguments by name, so a six-key body still matches this function and lands
-- exactly as it did — with `paint` left null, which for that build is true.
drop function if exists public.upsert_vehicle_meta(text, text, text, timestamptz, jsonb, jsonb);

create or replace function public.upsert_vehicle_meta(
  p_vin text, p_unit text, p_notes text, p_meta_updated_at timestamptz, p_structural jsonb, p_decode jsonb,
  p_paint text default null
) returns void language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.vehicles (user_id, vin, unit, notes, paint, meta_updated_at, structural, decode)
  values (auth.uid(), p_vin, p_unit, p_notes, p_paint, p_meta_updated_at,
          coalesce(p_structural, '{}'), coalesce(p_decode, '{}'))
  on conflict (user_id, vin) do update set
    unit            = case when excluded.meta_updated_at > vehicles.meta_updated_at then excluded.unit  else vehicles.unit  end,
    notes           = case when excluded.meta_updated_at > vehicles.meta_updated_at then excluded.notes else vehicles.notes end,
    paint           = case when excluded.meta_updated_at > vehicles.meta_updated_at then excluded.paint else vehicles.paint end,
    meta_updated_at = greatest(vehicles.meta_updated_at, excluded.meta_updated_at),
    structural      = case when vehicles.structural = '{}'::jsonb then excluded.structural else vehicles.structural end,
    decode          = public.better_decode(vehicles.decode, excluded.decode);
end $$;

-- The old signature's grants went with it. Same posture as 0001: `public` holds EXECUTE on a new
-- function by default, which would hand `anon` a call it can only fail, so take it back and
-- grant the role that uses it.
revoke all on function public.upsert_vehicle_meta(text, text, text, timestamptz, jsonb, jsonb, text) from public;
grant execute on function public.upsert_vehicle_meta(text, text, text, timestamptz, jsonb, jsonb, text) to authenticated;
