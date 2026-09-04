-- Stub of the parts of a Supabase project that 0001_init.sql leans on, so the tests in this
-- directory can run against a bare PostgreSQL as well as against `supabase start`.
--
-- This is NOT part of the application schema and is never applied by `supabase db push` — it
-- lives outside supabase/migrations/ for that reason. Against a real Supabase database every
-- block below finds what it creates already present and does nothing, so running it there is
-- harmless but pointless.
--
-- What it stubs: the `anon` / `authenticated` / `service_role` roles, the `auth.users` table the
-- two foreign keys reference, and `auth.uid()`. The real `auth.uid()` reads the JWT claims
-- PostgREST puts on the connection; the copy below is the same expression, so a test can be a
-- given user by setting `request.jwt.claims` and `set role authenticated` — which is exactly
-- what PostgREST does per request.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  -- BYPASSRLS mirrors Supabase: the service-role key is the only credential that sees every
  -- row, and it exists solely inside the delete-account Edge Function (CLAUDE.md rule 12).
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

-- `set role` requires membership. Supabase grants these to `postgres` already; granting a second
-- time only produces a notice, so ask first.
do $$
begin
  if not pg_catalog.pg_has_role(current_user, 'anon', 'member') then
    execute format('grant anon to %I', current_user);
  end if;
  if not pg_catalog.pg_has_role(current_user, 'authenticated', 'member') then
    execute format('grant authenticated to %I', current_user);
  end if;
  if not pg_catalog.pg_has_role(current_user, 'service_role', 'member') then
    execute format('grant service_role to %I', current_user);
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- Only the columns the foreign keys and the tests touch. GoTrue's real table has many more.
create table if not exists auth.users (
  id         uuid primary key,
  email      text,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute $fn$
      create function auth.uid() returns uuid language sql stable as $body$
        select coalesce(
          nullif(current_setting('request.jwt.claim.sub', true), ''),
          (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
        )::uuid
      $body$;
    $fn$;
    execute 'grant execute on function auth.uid() to anon, authenticated, service_role';
  end if;
end $$;
