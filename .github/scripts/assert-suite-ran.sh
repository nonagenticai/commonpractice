#!/usr/bin/env bash
#
# assert-suite-ran.sh <backend|frontend> <raw-log> <runner-exit-code> [expected-test-file-count]
#
# Decide whether a test suite ACTUALLY RAN AND PASSED, from its durable log, and exit 1 if not.
#
# ⛔ WHY THIS EXISTS. The exit code has been observed to lie. On run 32845326688 — the pipeline that
# built the image production is running right now — the `Frontend unit tests` step logged
#     ❯ src/lib/i18n/icu-number-params.sites.test.ts (99 tests | 1 failed)
#     ❯ src/lib/utils/format.locale.test.ts          (30 tests | 8 failed)
#     ❯ src/lib/i18n/icu-number-params.test.ts       (26 tests | 3 failed)
# and the job, the build, the deploy and the promote all reported `success`. Twelve failing tests
# shipped to prod under four green checks. `set -o pipefail` alone is not evidence that a suite was
# green; the durable log is.
#
# ⛔ WHY IT IS A FILE AND NOT INLINE YAML. Its first incarnation lived inline in the two `run:` blocks
# of .github/workflows/ci-cd.yaml, where it could not be exercised without merging. A line meant for
# the frontend step was pasted into the backend step, referencing a log the frontend had not written
# yet; steps run under `bash -e`, so sed's exit 2 killed every main pipeline for six merges — always
# AFTER a green `1853 pass / 0 fail`, so the failure looked like a test failure and was not one.
# As a file it has a unit test (backend/tests/ci-suite-guard.test.ts) that feeds it real captured
# logs in every state. Keep it that way.
#
# ⛔ `set -u -o pipefail` BUT NOT `-e`. This script OWNS its exit code — the caller reads it to decide
# whether the step failed. Under `-e` a `grep` that legitimately finds nothing would abort the script
# with grep's exit 1 before the verdict was computed, and a missing file would surface as the tool's
# own exit 2 rather than as a stated verdict.
set -uo pipefail

suite="${1:-}"
log="${2:-}"
rc_in="${3:-0}"

die() { echo "::error::assert-suite-ran: $*"; exit 1; }

case "$suite" in
  backend|frontend) ;;
  *) die "unknown suite '${suite}' (expected 'backend' or 'frontend')" ;;
esac
[ -n "$log" ] || die "no log path given for the ${suite} suite"

# A non-numeric or absent runner exit code is itself a broken caller — treat it as a failure rather
# than silently coercing it to 0, which is the direction that hides defects.
case "$rc_in" in
  ''|*[!0-9]*) die "runner exit code '${rc_in}' is not a number" ;;
esac
rc="$rc_in"

# ⛔ THE EXPECTED TEST-FILE COUNT IS A PARAMETER, NEVER A LITERAL IN THIS FILE.
#
# It is the 4th POSITIONAL argument and deliberately not an environment variable. Three reasons,
# each measured against this repo's own history:
#   * the unit test drives this script through argv, so a positional is exercised by the same
#     mechanism CI uses — an env var would be settable in the test and forgotten in the YAML, which
#     is exactly the shape of the "inline guard that could not be exercised without merging" bug
#     recorded above;
#   * an env var set by an earlier step leaks into later ones, so the FRONTEND floor could silently
#     be applied to the BACKEND arm — a sibling of the copy-paste that killed six main pipelines;
#   * a positional shows up in the workflow diff on the same line as the log path, so a reviewer
#     sees the number's provenance next to what it constrains.
#
# Absent or 0 disables the floor. That default is what keeps the guard backward-compatible with the
# 32-file green fixture: the number belongs to the CALLER's tree, not to this script.
expected_in="${4:-0}"
case "$expected_in" in
  '') expected=0 ;;
  *[!0-9]*) die "expected test-file count '${expected_in}' is not a number" ;;
  *) expected="$expected_in" ;;
esac

# ⛔ A missing log is NEVER "nothing to check". It is the single most important failure this guard
# catches: it means the suite did not run, or ran somewhere else, or an earlier line in the step
# died. Exit 1 with a stated reason — never let the tool's own errno escape as the step's status.
[ -r "$log" ] || die "${suite} log '${log}' does not exist or is unreadable — the suite did not run"

# ⛔ STRIP ANSI FIRST. vitest and bun colour their output under CI, so the runner's own markers are
# NOT contiguous in the raw file: `❯\e[39m src/…` and `|\e[22m\e[31m1 failed`. Measured on the real
# captured logs in backend/tests/fixtures/ci-logs: the frontend failure pattern matches 0 times raw
# and 11 times stripped. Grepping the raw file would BOTH miss every failure AND trip the
# non-vacuity floor on every honest run.
plain="$(mktemp)"
trap 'rm -f "$plain"' EXIT
esc=$(printf '\033')
sed -E "s/${esc}\[[0-9;]*m//g" "$log" > "$plain" || die "could not strip ANSI from '${log}'"

# `detected` is set by the FAILURE checks only, never by the non-vacuity floor. The floor is then
# skipped when it is set — a log with a failure in it is proof the suite ran, and printing "the suite
# did not run" beside a real failure states something false and sends the reader after the wrong
# thing. Measured on runs 32867564616 and 32870360124.
detected=0
fail() { echo "::error::$*"; rc=1; detected=1; }

# ⛔ A SEPARATE FAILURE CHANNEL FOR "DID NOT FINISH", AND IT MUST NOT SET `detected`.
# `detected` means "a real test failure was observed", and it is what suppresses the activity floor's
# "the suite did not run" message (a failure marker is proof the suite ran). A MISSING FOOTER is the
# opposite kind of evidence — it says nothing about whether anything ran — so routing it through
# fail() would set `detected` and silence the floor on an empty log, turning a two-line diagnosis
# into a one-line one about the wrong thing. rc only.
incomplete() { echo "::error::$*"; rc=1; }

if [ "$suite" = backend ]; then
  # bun's summary tally. Anchored at BOTH ends: `^\s*N fail\s*$` is the tally line and nothing else.
  # ⛔ The end anchor is load-bearing. A start anchor alone was measured to red a GREEN suite — a
  # passing test that does `console.log(' 3 fail')` writes at column 0 and matched. Test NAMES were
  # already safe; stdout was not, and stdout is the thing a debugging developer adds.
  if grep -qE '^[[:space:]]*[1-9][0-9]* fail[[:space:]]*$' "$plain"; then
    fail "backend suite reported failures (exit code said otherwise)"
  fi
  # bun's non-TTY per-test marker. The runner emits `(pass)`/`(fail)` lines alongside colour.
  if grep -qE '^[[:space:]]*\(fail\)' "$plain"; then
    fail "backend suite has (fail) lines (exit code said otherwise)"
  fi
  # bun's TTY per-test marker, for the colour reporter.
  if grep -qE '^[[:space:]]*✗ ' "$plain"; then
    fail "backend suite has ✗ lines (exit code said otherwise)"
  fi
  # ⛔ Non-vacuity, and it must demand a POSITIVE tally.
  # Skipped when a failure was already detected — see `detected` above. `[0-9]+ pass` was satisfied by ` 0 pass`, so
  # a run that collected nothing — a bad filter, a crashed preload, a glob that matched no files —
  # read as green with a tally in the log. Measured: a real `bun test` over an empty selection prints
  # ` 0 pass` / ` 0 fail` and exits 0.
  if [ "$detected" -eq 0 ] && ! grep -qE '^[[:space:]]*[1-9][0-9]* pass' "$plain"; then
    fail "no positive backend pass tally in the log — the suite ran nothing"
  fi
  # The same hole from the other side: bun's own count of what it executed.
  if grep -qE '^[[:space:]]*Ran 0 tests' "$plain"; then
    fail "backend suite ran 0 tests"
  fi
  # ⛔ COMPLETION, NOT ACTIVITY. `bun test` ends with `Ran 1931 tests across 209 files. [123.45s]`.
  # That line is written once, at the very end, after the last file has been executed — so its
  # ABSENCE means the process stopped early (signal, OOM, a preload that threw mid-run). A positive
  # `N pass` tally proves only that SOMETHING ran; it is satisfied by a run that executed 3 files of
  # 211 and then died. This is the backend half of the hole the frontend arm was measured falling
  # into on six consecutive main runs, and it is defence in depth: every real backend log carries
  # this line (fixture backend-green.log: `Ran 1828 tests across 197 files.`).
  ran_line=$(grep -E '^[[:space:]]*Ran [0-9]+ tests across [0-9]+ files?\.' "$plain" | tail -n 1)
  if [ -z "$ran_line" ]; then
    incomplete "backend suite printed no 'Ran N tests across M files' footer — THE SUITE DID NOT FINISH (it stopped before the end of the run; a pass tally alone is not completion)"
  elif [ "$expected" -gt 0 ]; then
    ran_files=$(printf '%s\n' "$ran_line" | sed -E 's/.*across ([0-9]+) files?\..*/\1/')
    case "$ran_files" in ''|*[!0-9]*) ran_files=0 ;; esac
    if [ "$ran_files" -lt "$expected" ]; then
      incomplete "backend suite finished over ${ran_files} test files but the repo has ${expected} — THE SUITE DID NOT FINISH the whole tree (files were skipped, filtered out, or the run died between files)"
    fi
  fi
else
  # vitest's per-FILE summary, e.g. `❯ src/foo.test.ts (26 tests | 3 failed)`.
  # ⛔ The `❯ ` prefix is required, not decoration: bare `\| N failed\)` is unanchored and matched a
  # passing test that printed that shape to stdout, reddening a green suite.
  if grep -qE '❯ .*\| [0-9]+ failed\)' "$plain"; then
    fail "frontend suite reported failing files (exit code said otherwise)"
  fi
  # ⛔ A FILE THAT NEVER COLLECTED HAS NO PER-FILE FAILURE MARKER. An import-time syntax error or a
  # bad mock renders as `❯ src/x.test.ts (0 test)` plus a footer, and the pattern above sees nothing.
  # These two footer lines are the only signal, so they are checked even though the ARC log-flush
  # race truncates the footer on some runs — additive evidence, never the sole floor.
  if grep -qE '^[[:space:]]*Test Files[[:space:]].*[0-9]+ failed' "$plain"; then
    fail "frontend suite footer reports failed test FILES (a file that never collected)"
  fi
  if grep -qE '^[[:space:]]*Errors[[:space:]]+[0-9]+ error' "$plain"; then
    fail "frontend suite reported unhandled errors"
  fi
  if grep -qE '❯ .*\(0 test\)' "$plain"; then
    fail "a frontend test file collected 0 tests — it failed to load"
  fi
  # ⛔ NON-VACUITY FLOOR, AND ITS NUMBER IS MEASURED, NOT CHOSEN. The ARC log-flush race truncates
  # this step's output badly and unpredictably: against a suite of 229 files, run 32867564616 left
  # 19 markers in the log and run 32870360124 left 18, both from runs that demonstrably EXECUTED
  # (each carried a real per-file failure). A floor of 20 therefore red-lit honest runs and printed
  # "the suite did not run" about a suite that had run — the guard telling its own lie, in the
  # opposite direction to the one it was built for.
  #
  # What this floor can honestly detect is ZERO: a step whose command never started, an empty file, a
  # crashed runner. Any positive count is evidence of execution. 5 keeps a margin over 0 without
  # pretending the log is complete, and it is skipped entirely when a failure was already detected,
  # because that failure is itself proof the suite ran.
  seen=$(grep -cE '(✓|❯) src/' "$plain")
  seen=${seen:-0}
  echo "assert-suite-ran: frontend test files seen in the log: ${seen}"
  if [ "$detected" -eq 0 ] && [ "$seen" -lt 5 ]; then
    fail "only ${seen} frontend test files in the log — the suite did not run"
  fi

  # ⛔⛔ COMPLETION. THIS IS THE CHECK THE `seen` FLOOR ABOVE CANNOT BE.
  #
  # The floor asks "did anything run?" and any positive number answers yes. It CANNOT ask "did the
  # run finish?", and finishing is the thing that was broken: runs 33011045728 and five other
  # consecutive main runs logged 18-25 of 248 files in 9-25 seconds, printed no footer, exited 0,
  # and promoted an image to `:latest`. `seen=20` sailed over a floor of 5 on every one of them.
  #
  # ⛔ THE OLD COMMENT HERE WAIVED THE FOOTER AS "the ARC log-flush race truncates it", AND THAT
  # WAIVER WAS FALSE. The `Show frontend test summary` step re-emits /tmp/frontend-test.log from
  # DISK in a fresh step with its own log-collection window — immune to any flush race — and the
  # file is ~24 lines with no footer in it. The footer is not being lost in transit. It was never
  # written, because vitest aborted. So: no footer == did not finish == hard fail.
  footer_line=$(grep -E '^[[:space:]]*Test Files[[:space:]]' "$plain" | tail -n 1)
  tests_line=$(grep -cE '^[[:space:]]*Tests[[:space:]]+[0-9]' "$plain")
  tests_line=${tests_line:-0}
  if [ -z "$footer_line" ] || [ "$tests_line" -eq 0 ]; then
    incomplete "frontend suite printed no 'Test Files …' / 'Tests …' footer — THE SUITE DID NOT FINISH (vitest writes both lines only after the last file; ${seen} file markers without them means the run aborted)"
  else
    # BOTH footer lines carry `… (N)` where N is the TOTAL, whichever shape they take:
    #     Test Files  32 passed (32)
    #     Test Files  2 skipped | 246 passed (248)
    # so the parenthesised number — not the `passed` number — is what must clear the bar. Taking the
    # LAST `(N)` on the line is what makes the `2 skipped | 246 passed (248)` shape parse correctly.
    total=$(printf '%s\n' "$footer_line" | sed -E 's/.*\(([0-9]+)\)[^0-9]*$/\1/')
    case "$total" in ''|*[!0-9]*) total=0 ;; esac
    echo "assert-suite-ran: frontend footer reports ${total} total test files"
    # ⛔ A FOOTER WITH NO `(N)` IN IT, CHECKED WITHOUT REFERENCE TO `$expected`. Two real shapes land
    # here and both must red even when no expected count was supplied:
    #   * ` Test Files  no tests` — what vitest prints when the include glob, a `--shard`, or a bad
    #     CLI flag selects nothing. Measured: a `--poolOptions.forks.minForks/maxForks` conflict in
    #     vitest 2.1 aborts with a RangeError and reports exactly this, i.e. a FLAG ERROR wearing an
    #     empty suite's clothes. Its `Tests` line is present, so the footer check above is satisfied.
    #   * a footer whose total was mangled in transit.
    # Left to the floor alone, `total=0` with `expected=0` reads as green.
    if [ "$total" -lt 1 ]; then
      incomplete "frontend footer carries no test-file total (\`${footer_line#"${footer_line%%[![:space:]]*}"}\`) — THE SUITE DID NOT FINISH over any file (vitest writes \`no tests\` here when the selection is empty)"
    fi
    if [ "$expected" -gt 0 ] && [ "$total" -lt "$expected" ]; then
      # ⛔ `>=` EXACT, NO TOLERANCE, AND THE REASON IS MEASURED. vitest's include is
      # `src/**/*.{test,spec}.{js,ts}` (frontend/vitest.config.ts) and the caller counts
      # `git ls-files -- frontend/src | grep -E '\.(test|spec)\.(js|ts)$'`. Measured 2026-08-27:
      # both resolve to the SAME 248 files (0 `.js` test files today, but the pattern covers them so
      # adding one cannot silently drop the bar). vitest's default `exclude` is node_modules/dist/
      # .git/.cache — none of which exist under frontend/src — so there is no legitimate reason for
      # the two sets to differ. A tolerance would therefore be a licence for the exact defect this
      # closes: 5% of 248 is 12 files that could vanish every run and stay green. If the two ever DO
      # diverge, this reds loudly on the next push and someone fixes the counting command — which is
      # the fail-CLOSED direction. `-lt`, not `-ne`: running MORE files than the index knows about
      # (a generated or untracked spec) is not a truncation and must not red the build.
      incomplete "frontend footer reports ${total} test files but the repo has ${expected} — THE SUITE DID NOT FINISH the whole tree"
    fi
  fi

  # ⛔ A FOOTER LEFT OVER FROM A PREVIOUS RUN. vitest prints its ` RUN  vX.Y.Z <root>` banner once per
  # run and its footer once per run, so a log holding two banners and one footer is a completed run
  # followed by an aborted one — and the checks above, which look at the LAST footer, would read the
  # stale one as this run's. Measured: fixture frontend-red-ansi.log really does contain TWO banners
  # (lines 3 and 175) and ZERO footers. Comparing the counts catches the stale-footer case that
  # `tail -n 1` alone cannot. Fails safe if the banner is ever absent: 0 runs demands 0 footers.
  runs=$(grep -cE '^[[:space:]]*RUN[[:space:]]+v[0-9]' "$plain"); runs=${runs:-0}
  footers=$(grep -cE '^[[:space:]]*Test Files[[:space:]]' "$plain"); footers=${footers:-0}
  if [ "$footers" -lt "$runs" ]; then
    incomplete "the log holds ${runs} vitest run banners but only ${footers} footers — at least one run in this log DID NOT FINISH"
  fi
fi

if [ "$rc" -ne 0 ]; then
  echo "assert-suite-ran: ${suite} suite FAILED (verdict rc=${rc})"
else
  echo "assert-suite-ran: ${suite} suite ran and passed"
fi
exit "$rc"
