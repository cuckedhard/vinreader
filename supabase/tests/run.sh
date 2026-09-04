#!/usr/bin/env bash
#
# Runs the S4 backend tests against a PostgreSQL database.
#
#   supabase/tests/run.sh                       # the local `supabase start` database
#   supabase/tests/run.sh "$DATABASE_URL"       # any database that already has 0001_init.sql
#   supabase/tests/run.sh --bootstrap "$URL"    # ... and apply 0001_init.sql first (empty db, CI)
#
# Needs `psql` on PATH and nothing else — no Docker, no pgTAP, no Supabase CLI. Each test file is
# one transaction ending in ROLLBACK, so running this against a live development project changes
# nothing; running it against production is still a bad idea, because a failed assertion aborts
# the transaction rather than the database and nobody should be pointing test fixtures at real
# user rows.
#
# Exit status is psql's: 0 when both files print their PASSED line, non-zero on the first failed
# assertion (ON_ERROR_STOP), which is what CI reads.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bootstrap=0
db_url="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

for arg in "$@"; do
  case "$arg" in
    --bootstrap) bootstrap=1 ;;
    -h | --help)
      sed -n '2,20p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) db_url="$arg" ;;
  esac
done

run() { psql -v ON_ERROR_STOP=1 -q -f "$1" "$db_url"; }

# Idempotent, and a no-op against a real Supabase project: it only creates what is missing.
run "$here/00_stub_supabase.sql"

if [ "$bootstrap" -eq 1 ]; then
  run "$here/../migrations/0001_init.sql"
fi

run "$here/10_rls_test.sql"
run "$here/20_merge_test.sql"
