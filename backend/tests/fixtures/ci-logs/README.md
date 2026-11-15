# CI test-suite log fixtures

Inputs for `backend/tests/ci-suite-guard.test.ts`, which drives
`.github/scripts/assert-suite-ran.sh` over them.

⛔ **None of these is hand-written.** A guard checked only against prose someone typed to match it
is self-confirming — that is precisely how the inline version shipped broken twice. Every file here
is real tool output, and every one carries real ESC (`0x1b`) bytes, because the whole correctness
argument is that the markers are **not contiguous** in the raw stream and must be de-coloured first.

| file | provenance |
|---|---|
| `frontend-red-ansi.log` | GitHub Actions run **32843136933** (PR #311), the `Frontend unit tests` step. The per-run prefix GitHub adds (`job\tstep\t<timestamp>Z `) is stripped and its escaped `^[` is restored to a real ESC byte, so the file is what `tee` wrote to `/tmp/frontend-test.log` on the runner. Contains 11 `\| N failed)` markers after de-colouring, **0** before. |
| `frontend-green-ansi.log` | `FORCE_COLOR=1 CI=1 bun run test <32 files>` run locally against `033d458`. 32 files / 614 tests / 0 failed. Used because **no completed CI run had a green frontend suite to capture** — the last one CI called `success` had 12 failures in it, which is the defect this guard exists for. |
| `backend-green.log` | GitHub Actions run **32845326688** (`a263b9a`), the `Run backend tests` step summary region. Same prefix/ESC treatment. |
| `backend-red.log` | `FORCE_COLOR=1 bun test` on a throwaway two-case file (one pass, one `expect(2+2).toBe(5)`), captured verbatim. Real `bun test` output, so the tally shape (` 1 pass` / ` 1 fail`) and its colouring are the tool's, not mine. |
| `frontend-truncated-ansi.log` | GitHub Actions run **33011045728** (`main` @ `697ecb3`, 2026-08-26T20:54Z), the `Frontend unit tests` step, lines `$ vitest run` … last `✓`. Same prefix/ESC treatment as the red log. ⛔ **This is the defect fixture.** 24 lines: the ` RUN  v2.1.9` banner, 20 `✓ src/…` markers out of the repo's **248** test files, and **no `Test Files` / `Tests` footer at all** — the suite aborted after 13s. The step exited 0, the guard printed `frontend suite ran and passed`, and the image was promoted to `:latest`. Its markers match 0 times raw and 20 times de-coloured. |
| `empty.log` | Zero bytes. The truncation case. |

## What each fixture has to keep proving

`frontend-green-ansi.log` is the only log here with a complete vitest footer, so it is the only one
that can prove the *completion* half of the guard (footer present, parenthesised total ≥ the caller's
expected count). `frontend-truncated-ansi.log` is its exact complement: real, green, and unfinished.
A guard that cannot tell those two apart is the guard that shipped 20-of-248 to production six times.

## Updating

If a fixture ever needs refreshing, **capture it, do not edit it**. `gh run view <id> --log` escapes
ESC as the two characters `^` `[`; convert them back to `0x1b` or the fixture stops representing the
runner's file and the ANSI-strip assertion goes vacuous.
