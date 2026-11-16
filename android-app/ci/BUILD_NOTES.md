# builder3 CI build notes (v2.12-wip)

- 2026-11-12: run 1 (4f30245) failed — zip pack step glob `lib/$ABI/*` executed from inside `jni/$ABI`; no match -> zip exit 12 -> `set -e` abort.
- 2026-11-12: run 2 (304c466) failed — same class of error; glob still resolved against wrong cwd (`jni/` has no `lib/` subdir).
- 2026-11-12: commit 682fe40 fixed staging (copy .so into `build/stage/lib/<abi>/` then zip from stage root) but carried `[skip ci]` in the message, so no run triggered.
- This note commit (no [skip ci]) intentionally triggers the workflow to exercise the fixed build script.
- On failure the build script pushes the full log to `android-app/ci/last-build.log` with a `[skip ci]` commit (no run loop).

## G1 repair round — 2026-11-13 (branch g1/repair-20261113)

- **Repair-branch trigger**: `.github/workflows/build-apk.yml` now pushes on
  `[ci-build-apk-20261112, g1/repair-20261113]` (workflow_dispatch kept). Before this,
  pushes to a repair branch triggered no workflow at all.
- **Timeouts (no more multi-hour hangs)**: job `timeout-minutes: 60`; the `Build APK`
  step (which runs build-apk.sh and then the emulator runtime suite) `timeout-minutes: 30`.
  Context: run 43471689561 (2026-11-13) sat >2 h in_progress inside Build APK.
- **No skip path**: build-apk.sh no longer honours `RUNTIME_SKIP`; every script run
  executes `runtime-test.sh all`. Every external call inside runtime-test.sh is bounded
  by a portable background+wait+kill watchdog (adb 90 s default, install/push 300 s,
  1536 MiB stub dd 600 s, boot deadline 900 s) — a hang is a loud TIMEOUT failure.
- **Evidence retention (always uploaded)**: artifact `g1-runtime-evidence` (retention
  14 days) contains `rt-out/results.txt` (metadata header, CASE_RESULT lines, OVERALL
  PASS/FAIL, finished_utc/exit_code) plus per-case logcat, meminfo, UI XML and
  `failures.txt`. It uploads with `if: always()`, so failed/timed-out runs keep their
  evidence. The APK artifact stays success-only (30-day retention). The results header
  is also echoed into the job summary.
- No product code, model pin, requirement or BUILD_TAG/version was changed in this round.
