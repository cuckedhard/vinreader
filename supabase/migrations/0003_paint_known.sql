-- VIN Relay — S5-1: a caller that has never heard of `paint` stops erasing it.
--
-- Migration 0002 gave `upsert_vehicle_meta` a seventh argument with `default null` so a build
-- from before S5 would still land its queued rows. It lands them — and takes the paint code with
-- it. The default is indistinguishable from a value, so a six-argument push carrying a newer
-- `meta_updated_at` reaches the LWW arm
--
--   paint = case when excluded.meta_updated_at > vehicles.meta_updated_at then excluded.paint …
--
-- with `excluded.paint` null, writes that null over a code the account holds, and the next pull
-- spreads it to every device. Any phone left un-updated is a standing eraser. This is *not* the
-- hazard §4.12 accepts for `unit` and `notes`: there an old build pushes a value it genuinely
-- holds, here it overwrites a column it has never heard of with nothing.
--
-- The fix is one more argument whose only job is to say **who is speaking**:
--
--   · `p_paint_known` true  — "I know this column exists; `p_paint` is my answer for it,
--                              including null, which means clear it";
--   · `p_paint_known` false — "ignore my `p_paint`";
--   · absent (null)        — nobody said, so the call itself is asked: a call that carries a
--                              code knows the column (there is no other way to send that key),
--                              and a call that carries nothing is assumed not to.
--
-- That last line is what makes the difference the fix turns on — "this caller does not know the
-- column exists" versus "this caller wants the value cleared" — decidable, and it keeps clearing
-- possible, which the S5 addendum requires: a paint code has no check digit and no grammar, so
-- the human who deleted a wrong one is the only thing that knows it was wrong and a merge that
-- could not carry a clear would resurrect it and state it as a fact again (N2).
--
-- Three callers, and what each of them gets:
--   · pre-S5 build (six keys, no `p_paint` at all) — `paint` untouched. The eraser is gone.
--   · S5 build as shipped (seven keys, `p_paint`, no flag) — a code it holds still propagates,
--     because the value answers for it. A *clear* from that build does not propagate; it stands
--     on the device that made it until that phone updates. Losing a clear leaves the account
--     holding a code a human deleted, which is a wrong code on other devices — worth reporting,
--     and far smaller than the account-wide erasure it replaces. The alternative — defaulting
--     the flag false — would silently drop every code that build types, which is the same class
--     of loss aimed at the other half of the same user's fleet.
--   · this build and later (eight keys, the flag always true) — full LWW, clearing included.
--
-- Why an argument and not an overload: PostgREST resolves RPC arguments by name, so a six-key
-- body still matches this function; but two candidate functions would make every six- and
-- seven-key call ambiguous and fail it. `create or replace` cannot change a parameter list, so —
-- exactly as 0002 did — the previous signature is dropped and the new one created.
--
-- The client half is `src/lib/sync/merge.ts` (§4.12: "identical on server and client"), where
-- the same question is asked of a pulled row: a row from an account whose schema predates the
-- column has no `paint` key at all, and a merge that read that absence as null would run this
-- same eraser in the pull direction.
--
-- Applied by `supabase db push` (remote) and by `supabase start` / `supabase db reset` (local).

-- 0002's signature, and 0001's for a database that somehow still carries it: leaving either in
-- place is the ambiguity this migration exists to avoid.
drop function if exists public.upsert_vehicle_meta(text, text, text, timestamptz, jsonb, jsonb, text);
drop function if exists public.upsert_vehicle_meta(text, text, text, timestamptz, jsonb, jsonb);

create or replace function public.upsert_vehicle_meta(
  p_vin text, p_unit text, p_notes text, p_meta_updated_at timestamptz, p_structural jsonb, p_decode jsonb,
  p_paint text default null, p_paint_known boolean default null
) returns void language plpgsql security invoker set search_path = '' as $$
declare
  -- Does this caller know the column exists? Explicit answer first; otherwise the call speaks
  -- for itself. `coalesce` and not `is not false`: an explicit false must stay false.
  v_paint_known boolean := coalesce(p_paint_known, p_paint is not null);
begin
  insert into public.vehicles (user_id, vin, unit, notes, paint, meta_updated_at, structural, decode)
  values (auth.uid(), p_vin, p_unit, p_notes,
          -- A caller that does not know the column supplies nothing for it, on a new row too.
          case when v_paint_known then p_paint end,
          p_meta_updated_at, coalesce(p_structural, '{}'), coalesce(p_decode, '{}'))
  on conflict (user_id, vin) do update set
    unit            = case when excluded.meta_updated_at > vehicles.meta_updated_at then excluded.unit  else vehicles.unit  end,
    notes           = case when excluded.meta_updated_at > vehicles.meta_updated_at then excluded.notes else vehicles.notes end,
    -- The same clock and the same comparison as `unit` and `notes` — a newer edit wins, a tie
    -- keeps what is stored, a clear propagates — but only for a caller that is answering about
    -- this column at all. Nothing else on the row is conditional on the caller's build, because
    -- nothing else can be pushed by a build that does not have it.
    paint           = case when v_paint_known and excluded.meta_updated_at > vehicles.meta_updated_at
                           then excluded.paint else vehicles.paint end,
    meta_updated_at = greatest(vehicles.meta_updated_at, excluded.meta_updated_at),
    structural      = case when vehicles.structural = '{}'::jsonb then excluded.structural else vehicles.structural end,
    decode          = public.better_decode(vehicles.decode, excluded.decode);
end $$;

-- The dropped signature's grants went with it. Same posture as 0001 and 0002: `public` holds
-- EXECUTE on a new function by default, which would hand `anon` a call it can only fail.
revoke all on function public.upsert_vehicle_meta(text, text, text, timestamptz, jsonb, jsonb, text, boolean) from public;
grant execute on function public.upsert_vehicle_meta(text, text, text, timestamptz, jsonb, jsonb, text, boolean) to authenticated;
