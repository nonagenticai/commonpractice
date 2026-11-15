#!/usr/bin/env bash
# db-preflight.sh — is the dev Postgres actually usable right now?
#
# ⛔ WHY THIS EXISTS. The local :5433 container degrades under this machine's FIXED Docker budget
# (~969 MB, 2 CPUs, not raisable — the Mac has 8 GB and agent sessions eat most of it). When it
# does, the failure NEVER says "the database is unwell". It says:
#
#     (fail) (unnamed) [5003.60ms]          <- a hook timeout naming neither file nor cause
#     write CONNECT_TIMEOUT localhost:5433
#     error: Failed query: delete from ...
#
# which is indistinguishable from a real regression. That ambiguity has cost multiple sessions
# hours, including one where a genuine test-debris bug was misdiagnosed twice as "the container".
#
# The usual cause is NOT this container: it is PARALLEL agent sessions each leaving their own
# throwaway Postgres running. One session had `bf-drift-pg`, `cp-sigterm-pg` and `md-test-pg`
# alongside this one — four Postgres instances sharing 969 MB.
#
# Run this BEFORE trusting a red test run. Exit 0 = the DB is fine, believe your failures.
set -uo pipefail

fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; }
warn() { printf '\033[33m! %s\033[0m\n' "$1"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

# 1. Is the daemon itself responsive? When Docker is wedged, `docker ps` hangs — so bound it.
if ! timeout 15 docker ps >/dev/null 2>&1; then
  fail "docker ps did not answer in 15s — the DAEMON is wedged, not just Postgres."
  echo "  Restart Docker Desktop. No amount of Postgres tuning will help."
  exit 1
fi
ok "docker daemon responsive"

# 2. ⛔ WHICH DATABASE ARE THE TESTS ACTUALLY GOING TO USE?
#
# This script used to hardcode `docker exec commonpractice-db` for every check and then print
# "Preflight passed — a red test run now most likely means a REAL failure". Measured 2026-08-26:
# `backend/.env` on this machine reads
#     DATABASE_URL=postgresql://commonpractice:commonpractice@localhost:5474/commonpractice
# i.e. a DIFFERENT container (`cp-union-pg`) on a DIFFERENT port from the one being inspected. The
# script was certifying the health of a database the test run never opens — it would have passed
# with the real target stopped, wedged, or four migrations stale. A probe that bypasses the thing
# it is vouching for cannot vouch for it.
#
# Precedence matches the app's: an exported DATABASE_URL wins, else `backend/.env` (Bun auto-loads
# it; `tests/setup-env.ts` only fills in what is unset), else the compose default.
env_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)/.env"
dsn="${DATABASE_URL:-}"
dsn_src="exported DATABASE_URL"
if [ -z "$dsn" ] && [ -f "$env_file" ]; then
  dsn=$(grep -E '^[[:space:]]*DATABASE_URL=' "$env_file" | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r')
  dsn_src="backend/.env"
fi
if [ -z "$dsn" ]; then
  dsn="postgresql://commonpractice:commonpractice@localhost:5433/commonpractice"
  dsn_src="compose default (no DATABASE_URL set)"
fi

# Split the DSN on its STRUCTURE rather than with one regex per field, because every field except
# the scheme sits to the right of a password that may legally contain '@', ':', '/' or '?'.
#   scheme://[userinfo@]host[:port]/dbname[?params]
dsn_rest=${dsn#*://}          # userinfo@host:port/db?x
dsn_authority=${dsn_rest%%/*} # userinfo@host:port
dsn_path=${dsn_rest#"$dsn_authority"}
# ⛔ THE LAST '@', NOT THE FIRST. `[^@/]*@` stopped at the first '@', so the password `p@ssw0rd`
# printed as `postgresql://***@ssw0rd@localhost:5474/db` — the tail of a live credential, in a line
# whose entire job is to be safe to paste into a handoff or a PR. `##*@` (longest leading match)
# spans to the LAST '@' inside the authority, and because the authority is cut at the first '/'
# first, it can never reach an '@' that lives in the path or the query string.
case "$dsn_authority" in
  # ⚠️ No credentials at all (`postgresql://localhost:5474/db`) MUST pass through untouched: a
  # greedy match with nothing to redact would otherwise eat the host.
  *@*) dsn_userinfo=${dsn_authority%@*}; dsn_hostport=${dsn_authority##*@} ;;
  *)   dsn_userinfo='';                  dsn_hostport=$dsn_authority ;;
esac
if [ -n "$dsn_userinfo" ]; then
  dsn_safe="${dsn%%://*}://***@${dsn_hostport}${dsn_path}"
else
  dsn_safe="$dsn"
fi
# host / port out of the authority. Bracketed IPv6 (`[::1]:5474`) keeps its colons.
case "$dsn_hostport" in
  \[*\]*) db_host=${dsn_hostport#\[}; db_host=${db_host%%\]*}; db_port=${dsn_hostport##*\]} ; db_port=${db_port#:} ;;
  *:*)    db_host=${dsn_hostport%%:*}; db_port=${dsn_hostport#*:} ;;
  *)      db_host=$dsn_hostport;       db_port='' ;;
esac
db_name=${dsn_path#/}; db_name=${db_name%%\?*}
db_user=${dsn_userinfo%%:*}
# A credential-less DSN leaves psql with no role to connect as. Say so rather than guessing.
if [ -z "$db_user" ]; then db_user=${PGUSER:-postgres}; fi
# ⛔ NO SILENT FALLBACK TO 5433. A DSN with no explicit port means Postgres's own default, 5432 —
# quietly substituting the compose port would re-create the exact bug this step exists to kill
# (checking a container the tests never open). If nothing publishes the resolved port the check
# below fails loudly, which is the correct outcome either way.
case "$db_port" in ''|*[!0-9]*) db_port=5432 ;; esac

ok "target: $dsn_safe   (from $dsn_src)"

# ⛔ THE PORT IS NOT THE ADDRESS. Every check below reaches the database through
# `docker exec <container> psql` on the LOCAL daemon, and the container is found by the published
# PORT alone. So `DATABASE_URL=…@10.255.255.1:5474/cp_lane_test` resolved the local container that
# happens to publish 5474, read ITS schema, and printed "73 applied, none missing / Preflight
# passed" — while a real connection to 10.255.255.1 hangs until the suite times out. That is the
# original "certifying a database the test run never opens" bug wearing a different hat: it moved
# from "wrong container" to "right port, wrong host". `docker exec` cannot reach a remote server,
# so the only honest answer for a non-local host is to refuse.
case "$db_host" in
  localhost|127.0.0.1|::1|0.0.0.0|host.docker.internal) ;;
  "$(hostname 2>/dev/null)"|"$(hostname -s 2>/dev/null)"|"$(hostname -f 2>/dev/null)") ;;
  *)
    fail "DSN host '${db_host}' is not this machine — this script cannot verify a REMOTE database."
    echo "  Every check below runs 'docker exec <container> psql' against the LOCAL docker daemon,"
    echo "  and the container is located by published port. For a remote host that would inspect a"
    echo "  DIFFERENT database that merely shares the port number, and vouch for it."
    echo "  Point DATABASE_URL at a local container, or verify the remote server by hand."
    echo "  ⛔ Until this passes, treat every test failure as UNRELIABLE."
    exit 1
    ;;
esac

# Name the container publishing that port, so the container-level checks below inspect the RIGHT
# one. `docker ps` prints e.g. "0.0.0.0:5433->5432/tcp" and "127.0.0.1:5474->5432/tcp".
DB_CONTAINER=$(docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null \
  | awk -F'\t' -v p=":${db_port}->" 'index($2, p) { print $1; exit }')
if [ -z "$DB_CONTAINER" ]; then
  fail "no running container publishes port ${db_port}, but that is where ${dsn_src} points."
  echo "  Either start it, or point DATABASE_URL at a database that exists."
  echo "  ⛔ Until this passes, treat every test failure as UNRELIABLE."
  exit 1
fi
ok "port ${db_port} is published by container '${DB_CONTAINER}'"

# One helper, so no check below can silently drift back to a hardcoded container/database.
q() { timeout 20 docker exec "$DB_CONTAINER" psql -U "$db_user" -d "$db_name" -tAc "$1" 2>/dev/null; }

# 3. Competing Postgres containers — the usual culprit.
# ⛔ EXCLUDE THE TARGET. This used to exclude the hardcoded `commonpractice-db`, so once the
# resolver above showed the tests actually use another container, this step listed the TARGET as a
# competitor and printed `docker stop <target>` — advice that would break the very run it is
# protecting. Exclude whatever `$DB_CONTAINER` resolved to, not a fixed name.
others=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -iE 'postgres|-pg$|-db$' | grep -vx "$DB_CONTAINER" || true)
if [ -n "$others" ]; then
  warn "OTHER Postgres containers are running and competing for the same ~969 MB:"
  echo "$others" | sed 's/^/    /'
  echo "  These belong to parallel sessions. Stop the ones you do not need:"
  echo "    docker stop $(echo "$others" | tr '\n' ' ')"
else
  ok "no competing Postgres containers"
fi

# 4. Is our container up?
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$DB_CONTAINER"; then
  fail "$DB_CONTAINER is not running.   docker compose up -d db"
  exit 1
fi
ok "$DB_CONTAINER is running"

# 5. Does it actually answer a QUERY? `pg_isready` and the healthcheck both pass while the
#    container is in crash recovery and every real query hangs — so ask it something real.
if ! q 'select 1' >/dev/null 2>&1; then
  fail "a trivial 'select 1' did not return in 20s — the DB is in recovery or I/O-starved."
  echo "  Recover with:  docker compose down && docker compose up -d db"
  echo "  Then wait for: docker exec $DB_CONTAINER pg_isready -U $db_user   (can take ~60s)"
  echo "  ⛔ Until this passes, treat every test failure as UNRELIABLE."
  exit 1
fi
ok "select 1 returned"

# 6. Recent crash-recovery / slow-checkpoint evidence in its own log.
slow=$(docker logs "$DB_CONTAINER" --tail 200 2>&1 | grep -cE 'checkpoint complete.*write=[0-9]{2,}\.|resetting unlogged relations|database system was not properly shut down' || true)
if [ "${slow:-0}" -gt 0 ]; then
  warn "its log shows crash recovery or multi-second checkpoints — it is under memory pressure."
  echo "  It may pass now and degrade mid-suite. Run touched files ONLY, solo, with pauses."
else
  ok "no crash-recovery/slow-checkpoint evidence in the recent log"
fi

# 7. Schema present AND CURRENT?
#
# ⛔ COUNTING ROWS IS NOT CHECKING THE SCHEMA. This step used to print "✓ _migrations has 69 rows"
# and fall straight through to "Preflight passed — believe your failures". 69 rows is a perfectly
# healthy-looking number; the tree had 73 migrations. Measured 2026-08-26: the shared container was
# four behind, so `datasets` had no `sync_error_code` and no `sync_error_detail` column at all, and
# every test touching them failed with a column error that reads exactly like a real regression —
# which is the ONE outcome this script exists to rule out. A count can only catch a DB that was
# never migrated; it is blind to one that is merely STALE, and stale is the common case, because a
# container outlives the branch that created it while `main` keeps adding migrations.
#
# So compare against the tree and NAME the missing files. `_migrations.filename` holds the basename,
# which is what `migrations/*.sql` gives us, so the diff is exact rather than a count subtraction —
# a count would also be satisfied by the wrong 73 files.
migrations_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../migrations" 2>/dev/null && pwd || true)"
applied=$(q 'select filename from _migrations order by filename' | tr -d ' \r')

if [ -z "$applied" ]; then
  fail "could not read _migrations — this DB has never been migrated."
  echo "  Run:  cd backend && bun run migrate"
  echo "  ⛔ Until this passes, treat every test failure as UNRELIABLE."
  exit 1
elif [ -z "$migrations_dir" ] || [ ! -d "$migrations_dir" ]; then
  # Never silently downgrade to the old row-count claim: if we cannot see the tree we cannot
  # support the "believe your failures" line, and saying so is the whole point of this script.
  warn "could not locate backend/migrations/ — cannot verify the schema is CURRENT."
  echo "  $(printf '%s\n' "$applied" | grep -c .) migration(s) applied, but nothing to compare against."
else
  missing=$(comm -23 \
    <(cd "$migrations_dir" && ls -1 *.sql 2>/dev/null | sort) \
    <(printf '%s\n' "$applied" | sort))
  if [ -n "$missing" ]; then
    fail "the DB schema is STALE — $(printf '%s\n' "$missing" | grep -c .) migration(s) on disk are not applied:"
    printf '%s\n' "$missing" | sed 's/^/    /'
    echo "  A test that touches anything these add will fail with a missing-column/table error"
    echo "  that is INDISTINGUISHABLE from a real regression."
    echo "  Fix (⛔ '$DB_CONTAINER' may be SHARED — check with other sessions before migrating it):"
    echo "    cd backend && bun run migrate"
    echo "  Or point your run at your own DB:  DATABASE_URL=... bun run test <files>"
    exit 1
  fi
  ok "_migrations is current — $(printf '%s\n' "$applied" | grep -c .) applied, none missing from the tree"
fi

echo
ok "Preflight passed — a red test run now most likely means a REAL failure."
