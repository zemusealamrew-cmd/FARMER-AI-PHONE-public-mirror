#!/usr/bin/env bash
# builder3 — G1 runtime verification on a GitHub Actions Android emulator (v2.12-wip).
# v31 — xfergate ZIP-PATH fix (root cause confirmed by the CI log and by code review):
#      in every v30* run, case_xfergate built its fixture zips inside a subshell that
#      `cd`s into the stage dir while $OUT was still the RELATIVE path "rt-out/xfergate".
#      zip resolves the archive path relative to the NEW cwd, where that path does not
#      exist (and zip does not create intermediate dirs) — zip exited non-zero with NO
#      archive created, and the error was not checked; the very next xfer_push then
#      failed on the missing local file. Hence every v30* run failed identically at
#      xfer-1 regardless of the transport fixes tried in v30b–v30e.
#      FIX (scoped to case_xfergate ONLY):
#        (1) $OUT_BASE/xfergate is mkdir'd and $OUT is resolved to an ABSOLUTE path
#            before any fixture work, so the cd inside the zip subshells no longer
#            affects the archive path;
#        (2) every fixture-zip creation now has `|| fail` — a zip failure is LOUD;
#        (3) xfer-2's tamper is now SAME-SIZE different-content, so the size guard
#            PASSES and the SHA guard fires — that is the guard the assertion greps
#            ("manifest sha mismatch"); the previous different-size tamper tripped the
#            size guard first and the evidence line never appeared.
#      v30e's binary-safe push (adb exec-out) + both-sides SHA-256 integrity checks on
#      xfer1..xfer5 are retained unchanged. All other case bodies, the CI workflow, and
#      its triggers are untouched (no workflow change made, so nothing to remove).
#      Honest split unchanged: CI fixtures are bytes, NOT weights — the full ok=5 import
#      only happens with the owner's real zip on the A53.
# (v30e: adb exec-out binary-safe channel; v30d: run-as internal-files probe path;
#  v30c: honest fixture expectations; v28c OTP self-check; Run-19/21-verified case
#  bodies preserved verbatim.)
# REPAIR ROUND 2026-11-13 (branch g1/repair-20261113) — CI robustness ONLY, no case
# semantics changed, no assertion weakened, no case removed, no RUNTIME_SKIP path added:
#   (1) every potentially-hanging external call (adb *, sdkmanager, avdmanager, javac,
#       java) now runs under a portable background+wait+kill watchdog (GNU timeout is
#       NOT assumed) — a hang becomes a LOUD "TIMEOUT" failure instead of a run stuck
#       in_progress for hours (cf. run 43471689561, hung >2h in Build APK);
#   (2) the emulator boot loop has an overall deadline (BOOT_LIMIT_S, default 900s);
#   (3) an EXIT trap always tears the emulator down;
#   (4) results.txt gets a metadata header + OVERALL PASS/FAIL line, and every FAIL+
#       timestamp is additionally appended to failures.txt, so the always-uploaded
#       evidence artifact is self-describing even when the run dies early.
set -uo pipefail   # NOT -e: every step asserts explicitly with a clear FAIL message

CASE="${1:?usage: runtime-test.sh <launch|keyoff|asrgate|voicegate|smsgate|xfergate|ramguard|callgate|all>}"
APK="android-app/g1-amharic-ai-debug.apk"
PKG=phone.farmer.g1ai
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
IMG="system-images;android-34;default;x86_64"
# Evidence directory. Relative by default (repo root = the CI working directory, so the
# workflow uploads rt-out/). Overridable ONLY for local runs: RUNTIME_OUT_DIR=...
OUT_BASE="${RUNTIME_OUT_DIR:-rt-out}"
mkdir -p "$OUT_BASE"

fail() { echo "FAIL: $*"; echo "FAIL: $*" >>"${OUT_BASE:-rt-out}/failures.txt" 2>/dev/null || true; exit 1; }
ok()   { echo "OK: $*"; }

# --- bounded external calls (repair round 2026-11-13) -------------------------
# GNU `timeout` is NOT assumed (GitHub runner images and the owner's Git-Bash host
# differ), so every potentially-hanging external call goes through a portable
# background + wait + kill watchdog. A timeout is a LOUD failure (exit 124); it is
# never a silent skip and never weakens an assertion.
TIMEOUT_S_DEFAULT="${TIMEOUT_S_DEFAULT:-90}"
run_bounded() { # $1=seconds  $2=description  rest=command
  local secs="$1" desc="$2"; shift 2
  "$@" <&0 &                       # <&0 keeps stdin (needed by adb exec-out pushes)
  local pid=$!
  ( sleep "$secs"; kill -TERM "$pid" 2>/dev/null; sleep 2; kill -KILL "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  local wd=$!
  wait "$pid"; local rc=$?
  kill -TERM "$wd" 2>/dev/null || true
  if [ "$rc" -eq 143 ] || [ "$rc" -eq 137 ] || [ "$rc" -eq 124 ]; then
    # Loud on stderr AND persisted: several call sites redirect stderr, so the
    # always-uploaded evidence must carry the timeout itself.
    echo "TIMEOUT after ${secs}s: ${desc}" | tee -a "${OUT_BASE:-rt-out}/timeouts.txt" >&2
    return 124
  fi
  return "$rc"
}

# Resolve the REAL adb binary once (the `adb` name below is a shell function), then
# shadow `adb` so EVERY adb call in this file is bounded without touching each site.
ADB_BIN=""
adb() {
  if [ -z "$ADB_BIN" ]; then
    ADB_BIN="${SDK}/platform-tools/adb"
    if [ ! -x "$ADB_BIN" ] && [ -x "${ADB_BIN}.exe" ]; then ADB_BIN="${ADB_BIN}.exe"; fi
    if [ ! -x "$ADB_BIN" ]; then ADB_BIN="$(type -P adb 2>/dev/null || true)"; fi
    if [ -n "$ADB_BIN" ] && [ ! -x "$ADB_BIN" ] && [ -x "${ADB_BIN}.exe" ]; then ADB_BIN="${ADB_BIN}.exe"; fi
  fi
  [ -n "$ADB_BIN" ] && [ -x "$ADB_BIN" ] || { echo "FAIL: adb binary not found" >&2; return 127; }
  run_bounded "${ADB_TIMEOUT_S:-$TIMEOUT_S_DEFAULT}" "adb $*" "$ADB_BIN" "$@"
}
# Short bound for boot polling; long bound for install/push; extra-long for the
# 1536 MiB RAM-guard stub. Per-call overrides live in the function locals so they
# do not leak into other calls.
adb_fast()  { local ADB_TIMEOUT_S="${ADB_FAST_TIMEOUT_S:-15}"; adb "$@"; }
adb_slow()  { local ADB_TIMEOUT_S="${ADB_SLOW_TIMEOUT_S:-300}"; adb "$@"; }
adb_xslow() { local ADB_TIMEOUT_S="${ADB_XSLOW_TIMEOUT_S:-600}"; adb "$@"; }

# --- evidence footer + emulator teardown (one EXIT trap for the whole run) -----
# Appends a machine-readable footer to results.txt and kills the emulator if it was
# started. Verified in bash that this trap is NOT inherited by the per-case
# `( run_case )` subshells, so one failing case neither stops later cases nor tears
# the emulator down. This is what makes the always-uploaded evidence self-describing
# even when the run dies (e.g. boot timeout) before any case completes.
cleanup_on_exit() {
  local rc=$?
  echo "finished_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) exit_code=$rc" >>"$OUT_BASE/results.txt" 2>/dev/null || true
  if [ -n "${EMU_PID:-}" ]; then kill "$EMU_PID" 2>/dev/null || true; fi
}
trap cleanup_on_exit EXIT

ui_text() {
  local X=""
  for i in 1 2 3 4 5; do
    adb shell rm -f /sdcard/ui_g1_dump.xml >/dev/null 2>&1 || true
    adb shell uiautomator dump /sdcard/ui_g1_dump.xml >/dev/null 2>&1 || true
    X="$(adb shell cat /sdcard/ui_g1_dump.xml 2>/dev/null | tr -d '\r')"
    [ -n "$X" ] && { printf '%s' "$X"; return 0; }
    sleep 2
  done
  printf ''
}

# One bounded UI snapshot. The old helper reused /sdcard/ui.xml: if uiautomator
# dumped nothing (transient failure while telephony UI tears down) the stale file
# was read back and the assertion failed even when the app UI had updated.
ui_text_once() {
  local f=/sdcard/ui_g1_once.xml
  adb shell rm -f "$f" >/dev/null 2>&1 || true
  adb shell uiautomator dump "$f" >/dev/null 2>&1 || true
  adb shell cat "$f" 2>/dev/null | tr -d '\r'
}

alive() { [ -n "$(adb shell pidof "$PKG" 2>/dev/null | tr -d '\r')" ]; }
assert_alive() { alive || fail "$1: app process not alive"; }
assert_no_crash() { if grep -q "FATAL EXCEPTION" "$2" 2>/dev/null && grep -q "$PKG" "$2" 2>/dev/null; then fail "$1: crash detected"; fi; }
assert_no_anr()   { if grep -q "ANR in $PKG" "$2" 2>/dev/null; then fail "$1: ANR detected"; fi; }
assert_no_lmk()   { if grep -qE "Kill '$PKG'|lowmemorykiller.*$PKG" "$2" 2>/dev/null; then fail "$1: LMK killed the app"; fi; }

capture() { adb logcat -d >"$OUT/$1.logcat" 2>/dev/null || true
            adb shell cat /proc/meminfo 2>/dev/null | head -n 2 >"$OUT/$1.meminfo" || true; }

restart() { adb shell am force-stop "$PKG" >/dev/null 2>&1 || true; sleep 2; }

boot_emulator() {
  echo "== install emulator + system image + AVD =="
  # repair round: SDK-manager downloads are bounded (they are the other classic hang).
  run_bounded 300 "sdkmanager --licenses" bash -c 'yes | sdkmanager --licenses >/dev/null 2>&1' || true
  run_bounded 900 "sdkmanager emulator install" sdkmanager "emulator" >"$OUT_BASE/sdkmanager-emulator.log" 2>&1 || { cat "$OUT_BASE/sdkmanager-emulator.log"; fail "sdkmanager: emulator package install (bounded 900s)"; }
  run_bounded 1200 "sdkmanager system image install" sdkmanager "$IMG" >"$OUT_BASE/sdkmanager-image.log" 2>&1 || { cat "$OUT_BASE/sdkmanager-image.log"; fail "sdkmanager: system image install (bounded 1200s)"; }
  export PATH="$SDK/platform-tools:$SDK/emulator:$PATH"
  # repair round: resolve the REAL binaries here. `command -v adb` would now resolve
  # the bounded shell wrapper above, not the binary, so check executables directly
  # (and accept the .exe suffix used by the owner's Windows/Git-Bash host).
  ADB_BIN="$SDK/platform-tools/adb"
  if [ ! -x "$ADB_BIN" ] && [ -x "${ADB_BIN}.exe" ]; then ADB_BIN="${ADB_BIN}.exe"; fi
  if [ ! -x "$ADB_BIN" ]; then ADB_BIN="$(type -P adb 2>/dev/null || true)"; fi
  if [ -n "$ADB_BIN" ] && [ ! -x "$ADB_BIN" ] && [ -x "${ADB_BIN}.exe" ]; then ADB_BIN="${ADB_BIN}.exe"; fi
  [ -n "$ADB_BIN" ] && [ -x "$ADB_BIN" ] || fail "adb binary not found after platform-tools export"
  EMU="$SDK/emulator/emulator"
  if [ ! -x "$EMU" ] && [ -x "${EMU}.exe" ]; then EMU="${EMU}.exe"; fi
  if [ ! -x "$EMU" ]; then EMU="$(type -P emulator 2>/dev/null || true)"; fi
  if [ -n "$EMU" ] && [ ! -x "$EMU" ] && [ -x "${EMU}.exe" ]; then EMU="${EMU}.exe"; fi
  [ -n "$EMU" ] && [ -x "$EMU" ] || fail "emulator binary not found after install"
  echo "adb=$ADB_BIN emulator=$EMU"

  export ANDROID_AVD_HOME="$HOME/.android/avd"
  export ANDROID_PREFS_ROOT="$HOME/.android"
  unset ANDROID_SDK_HOME
  unset ANDROID_USER_HOME
  mkdir -p "$ANDROID_AVD_HOME"
  echo "HOME=$HOME AVD_HOME=$ANDROID_AVD_HOME PREFS=$ANDROID_PREFS_ROOT"
  echo "ANDROID_HOME=${ANDROID_HOME:-<unset>} ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT:-<unset>}"
  echo "ANDROID_SDK_HOME=${ANDROID_SDK_HOME:-<unset>} ANDROID_USER_HOME=${ANDROID_USER_HOME:-<unset>} (both must be <unset>)"

  echo "== PRE-CREATE DIAGNOSTICS =="
  echo "-- java version --"
  java -version 2>&1 || true
  echo "-- cmdline-tools evidence --"
  command -v avdmanager || true
  ls -la "$SDK/cmdline-tools" 2>&1 || true
  sdkmanager --version 2>&1 | head -n 3 || true
  echo "-- write permission on $ANDROID_AVD_HOME --"
  if touch "$ANDROID_AVD_HOME/.wtest" 2>/dev/null; then rm -f "$ANDROID_AVD_HOME/.wtest"; echo "WRITABLE"; else echo "NOT WRITABLE"; fi
  echo "-- system image dir --"
  ls -la "$SDK/system-images/android-34/default/x86_64" 2>&1 | head -20 || true
  echo "-- existing AVDs --"
  avdmanager list avd 2>&1 || true

  echo "== AVD CREATE (v13 config: ANDROID_SDK_HOME unset — verified by Run 17: exit 0) =="
  echo no | avdmanager --verbose create avd -n g1rt -k "$IMG" >"$OUT_BASE/avdmanager.log" 2>&1
  AVMGR_RC=$?
  echo "avdmanager exit code: $AVMGR_RC"
  cat "$OUT_BASE/avdmanager.log"
  [ "$AVMGR_RC" -eq 0 ] || fail "avdmanager create (exit=$AVMGR_RC, full verbose output above)"

  echo "== AVD dir contents after create =="
  ls -la "$ANDROID_AVD_HOME" 2>&1 || echo "(no avd dir)"

  if [ ! -f "$ANDROID_AVD_HOME/g1rt.ini" ]; then
    FOUND="$(find "$HOME" "$SDK" -maxdepth 6 -name 'g1rt.ini' -print 2>/dev/null | head -n 1 || true)"
    echo "g1rt.ini not at ANDROID_AVD_HOME; find result: ${FOUND:-<nowhere>}"
    if [ -n "$FOUND" ]; then
      SRC_DIR="$(dirname "$FOUND")"
      cp "$FOUND" "$ANDROID_AVD_HOME/g1rt.ini" 2>/dev/null || true
      [ -d "$SRC_DIR/g1rt.avd" ] && cp -r "$SRC_DIR/g1rt.avd" "$ANDROID_AVD_HOME/" 2>/dev/null || true
      echo "relocated AVD from $SRC_DIR into $ANDROID_AVD_HOME"
    fi
  fi

  [ -f "$ANDROID_AVD_HOME/g1rt.ini" ] || fail "g1rt.ini not found anywhere under HOME/SDK after avdmanager create"

  LIST="$($EMU -list-avds 2>&1 || true)"
  echo "emulator -list-avds => $LIST"
  printf '%s\n' "$LIST" | grep -qx "g1rt" || fail "g1rt NOT visible to emulator -list-avds"

  CFG="$ANDROID_AVD_HOME/g1rt.avd/config.ini"
  if [ -f "$CFG" ]; then echo "disk.dataPartition.size=6G" >>"$CFG"; fi

  echo "== KVM diagnostics (Run 17 failure: 'This user doesn\'t have permissions to use KVM') =="
  if [ -e /dev/kvm ]; then
    ls -l /dev/kvm
    id || true
    groups || true
    if [ -w /dev/kvm ]; then
      echo "KVM_WRITABLE — no fix needed"
    else
      echo "KVM_PRESENT_NOT_WRITABLE — applying minimal permission fix (runner has passwordless sudo)"
      sudo chmod 0666 /dev/kvm 2>&1 || true
      ls -l /dev/kvm
      [ -w /dev/kvm ] || fail "KVM permission fix failed — /dev/kvm still not writable for $(id -un)"
      echo "KVM_WRITABLE_AFTER_FIX"
    fi
  else
    ls -l /dev/kvm 2>&1 || true
    fail "/dev/kvm not present on this runner — KVM-backed x86_64 emulator unavailable; owner decision required for a KVM-enabled self-hosted runner or software-rendering fallback"
  fi

  echo "== boot emulator (KVM, headless) =="
  nohup "$EMU" -avd g1rt -no-window -gpu swiftshader_indirect -no-boot-anim \
    -no-snapshot -memory "${EMU_MEMORY:-2048}" >"$OUT_BASE/emulator.log" 2>&1 &
  EMU_PID=$!
  BOOT_START_S="$(date +%s)"
  BOOT_LIMIT_S="${BOOT_LIMIT_S:-900}"
  boot=""
  for i in $(seq 1 150); do
    if [ "$(( $(date +%s) - BOOT_START_S ))" -ge "$BOOT_LIMIT_S" ]; then
      adb devices 2>/dev/null || true; tail -n 40 "$OUT_BASE/emulator.log"
      fail "boot timeout (> ${BOOT_LIMIT_S}s overall — bounded, not an infinite wait)"
    fi
    st="$(adb_fast get-state 2>/dev/null || true)"
    if [ "$st" = "device" ]; then
      boot="$(adb_fast shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
      [ "$boot" = "1" ] && break
    fi
    if ! kill -0 "$EMU_PID" 2>/dev/null; then tail -n 40 "$OUT_BASE/emulator.log"; fail "emulator process died"; fi
    sleep 5
  done
  if [ "$boot" != "1" ]; then adb devices 2>/dev/null || true; tail -n 40 "$OUT_BASE/emulator.log"; fail "boot timeout (poll loop exhausted — bounded)"; fi
  ok "emulator booted"
}

install_apk() {
  # repair round: adb install is bounded (300s); a timeout reports as a TIMEOUT line
  # plus this FAIL — it can never block the job forever.
  adb_slow install -r "$APK" >/dev/null 2>&1 || fail "apk install (failed or TIMEOUT at ${ADB_SLOW_TIMEOUT_S:-300}s)"
  adb shell pm grant "$PKG" android.permission.RECORD_AUDIO >/dev/null 2>&1 || true
  adb shell pm grant "$PKG" android.permission.READ_PHONE_STATE >/dev/null 2>&1 || true
  adb shell pm grant "$PKG" android.permission.READ_SMS >/dev/null 2>&1 || true
}

otp_self_check() {
  OUT="$OUT_BASE/otpcheck"; mkdir -p "$OUT"
  PROJ="$(cd "$(dirname "$0")/.." && pwd)"
  AJAR="$SDK/platforms/android-35/android.jar"
  [ -f "$AJAR" ] || AJAR="$SDK/platforms/android-34/android.jar"
  [ -f "$AJAR" ] || fail "otpcheck: android.jar not found"
  mkdir -p "$OUT/classes"
  sed -n '/public static boolean isOtp/,/^  }$/p' "$PROJ/src/phone/farmer/g1ai/SmsReader.java" > "$OUT/isotp.inc" || fail "otpcheck: isOtp extraction failed"
  [ -s "$OUT/isotp.inc" ] || fail "otpcheck: isOtp extraction produced no content"
  cat > "$OUT/SmsOtp.java" <<'JAVAEOF'
public class SmsOtp {
JAVAEOF
  cat "$OUT/isotp.inc" >> "$OUT/SmsOtp.java"
  cat >> "$OUT/SmsOtp.java" <<'JAVAEOF'
  public static void main(String[] a) {
    int bad = 0;
    String[] otpMust = {
      "123456",
      "Your code is 458921",
      "OTP: 993211",
      "verification code 55123",
      "PIN 4412",
      "ቁጥር 776511"
    };
    String[] notOtp = {
      "Meeting at 5pm tomorrow",
      "Balance: 1200 birr"
    };
    for (String s : otpMust) if (!SmsOtp.isOtp(s)) { bad++; System.out.println("FAIL classified as NOT-OTP: " + s); }
    for (String s : notOtp) if (SmsOtp.isOtp(s)) { bad++; System.out.println("FAIL classified as OTP: " + s); }
    if (bad > 0) { System.out.println("OTP CLASSIFIER FAILED: " + bad); System.exit(1); }
    System.out.println("OTP CLASSIFIER OK: all cases correct");
  }
}
JAVAEOF
  run_bounded 240 "javac otpcheck" javac -encoding UTF-8 -d "$OUT/classes" "$OUT/SmsOtp.java" >"$OUT/compile.log" 2>&1 || { cat "$OUT/compile.log"; fail "otpcheck: javac failed on the REAL classifier (bounded 240s)"; }
  run_bounded 120 "java otpcheck" java -Dfile.encoding=UTF-8 -cp "$OUT/classes" SmsOtp >"$OUT/run.log" 2>&1 || { cat "$OUT/run.log"; fail "otpcheck: classifier self-check failed (bounded 120s)"; }
  cat "$OUT/run.log"
  ok "otpcheck: OTP classifier verified against the shipped source"
}

mk_manifest() { # $1=stage_dir $2=manifest_path
  python3 - "$1" "$2" <<'PYEOF'
import hashlib, json, os, sys
stage, out = sys.argv[1], sys.argv[2]
files = []
for n in sorted(os.listdir(stage)):
    if n == 'manifest.json': continue
    p = os.path.join(stage, n)
    if not os.path.isfile(p): continue
    h = hashlib.sha256(open(p,'rb').read()).hexdigest()
    files.append({'name': n, 'bytes': os.path.getsize(p), 'sha256': h})
json.dump({'schema': 1, 'files': files}, open(out,'w'))
PYEOF
}

# v30e: binary-safe push via `adb exec-out` (adb shell does pty CR/LF translation on
# stdin and CORRUPTS binaries) + integrity verification on both sides. A channel
# failure now fails LOUDLY at the push step with a distinctive CHANNEL message.
xfer_push() { # $1=local file, $2=device-side name
  # 2026-11-14 REPAIR: the exec-out stdin channel proved to hang on adb 37 / Android-14
  # (0-byte file + watchdog TIMEOUT; reproduced on the owner host and seen in run
  # 43505688748). Fixtures are now delivered with adb push into the app's OWN external
  # files dir, which the app can read under scoped storage; the app imports the same
  # file:// URI and both-side sha256 is still verified, so nothing is weakened.
  local rem="/sdcard/Android/data/$PKG/files/$2"
  adb_slow push "$1" "$rem" >/dev/null 2>&1 || fail "xfer-push($2): adb push failed (CHANNEL or TIMEOUT at ${ADB_SLOW_TIMEOUT_S:-300}s)"
  local local_sha dev_sha
  local_sha="$(sha256sum "$1" | cut -d' ' -f1)"
  dev_sha="$(adb_slow shell "sha256sum $rem" 2>/dev/null | tr -d '\r\n' | cut -d' ' -f1)"
  [ -n "$dev_sha" ] || fail "xfer-push($2): device-side sha256sum produced no output (CHANNEL)"
  [ "$local_sha" = "$dev_sha" ] || fail "xfer-push($2): INTEGRITY MISMATCH local=$local_sha device=$dev_sha — the binary channel corrupted the zip (CHANNEL, not app logic)"
  echo "xfer-push($2): integrity OK sha256=${local_sha:0:16}…"
}

# v30d/v30e: echo the app's G1XFER evidence for the CI log (diagnosability).
xfer_evidence() { # $1=capture tag
  echo "-- G1XFER evidence ($1) --"
  grep -a "G1XFER" "$OUT/$1.logcat" 2>/dev/null | tail -20 || echo "(no G1XFER lines)"
}

case_xfergate() {
  OUT="$OUT_BASE/xfergate"; mkdir -p "$OUT"
  # v31 FIX (root cause of the v30* failures, confirmed in the CI log + code): resolve
  # $OUT to an ABSOLUTE path — the fixture-zip subshells below cd into $V; with the
  # previous RELATIVE path, zip resolved the archive path against the stage dir (where
  # it does not exist), created NO archive, and the unchecked error made every
  # xfer_push fail on a missing local file.
  OUT="$(cd "$OUT" && pwd)"
  STG="$OUT/stage"; rm -rf "$STG"; mkdir -p "$STG"
  # repair 2026-11-14: fixture zip lives in the app's own external files dir (adb push
  # above); the app reads it under scoped storage and the importer path is unchanged.
  XURI_BASE="file:///storage/emulated/0/Android/data/$PKG/files"

  # xfer-1: VALID fixture package -> 3 unpinned staged + 3 required-missing reported + orm GAP.
  local V="$STG/v1"; mkdir -p "$V"
  printf 'fixture-asr-data' > "$V/asr.onnx.data"
  printf 'fixture-featspec' > "$V/featspec.json"
  printf 'fixture-orm-vocab' > "$V/vocab-orm.json"
  mk_manifest "$V" "$V/manifest.json"
  ( cd "$V" && zip -q "$OUT/xfer1.zip" ./* ) || fail "xfer-1: fixture zip creation failed"
  xfer_push "$OUT/xfer1.zip" "xfer1.zip"
  restart; adb logcat -c
  adb shell am start -n "$PKG/.MainActivity" --ez xfer_test true --es xfer_uri "$XURI_BASE/xfer1.zip" >/dev/null 2>&1 || fail "xfer-1: am start"
  sleep 8
  capture xfer-1
  xfer_evidence xfer-1
  grep -q "G1XFER.*ok=3 fail=3" "$OUT/xfer-1.logcat" 2>/dev/null || fail "xfer-1: unexpected outcome (expected ok=3 staged + 3 required-missing reported)"
  grep -q "G1XFER.*ormTts=false" "$OUT/xfer-1.logcat" 2>/dev/null || fail "xfer-1: orm absence not reported as GAP (ormTts=false missing)"
  assert_alive xfer-1; assert_no_crash xfer-1 "$OUT/xfer-1.logcat"

  # xfer-2: TAMPERED file -> rejected, nothing staged.
  local T="$STG/v2"; mkdir -p "$T"
  printf 'original-content' > "$T/featspec.json"
  mk_manifest "$T" "$T/manifest.json"
  # v31: SAME-SIZE tamper (both 16 bytes) — the size guard must PASS so the SHA guard
  # fires; the SHA-guard evidence line is what the assertion greps.
  printf 'TAMPERED-CONTENT' > "$T/featspec.json"
  ( cd "$T" && zip -q "$OUT/xfer2.zip" ./* ) || fail "xfer-2: fixture zip creation failed"
  xfer_push "$OUT/xfer2.zip" "xfer2.zip"
  restart; adb logcat -c
  adb shell am start -n "$PKG/.MainActivity" --ez xfer_test true --es xfer_uri "$XURI_BASE/xfer2.zip" >/dev/null 2>&1 || fail "xfer-2: am start"
  sleep 8
  capture xfer-2
  xfer_evidence xfer-2
  grep -q "G1XFER.*manifest sha mismatch" "$OUT/xfer-2.logcat" 2>/dev/null || fail "xfer-2: tamper rejection not evidenced"
  adb shell "run-as $PKG sh -c 'ls files/asr/ 2>/dev/null | grep -q featspec'" && fail "xfer-2: tampered file WAS staged"
  assert_alive xfer-2; assert_no_crash xfer-2 "$OUT/xfer-2.logcat"

  # xfer-3: REGISTRY reject — exact registry size, wrong content; the guard itself must reject.
  local R="$STG/v3"; mkdir -p "$R"
  dd if=/dev/zero of="$R/asr.onnx" bs=4536652 count=1 status=none || fail "xfer-3: fixture"
  mk_manifest "$R" "$R/manifest.json"
  ( cd "$R" && zip -q "$OUT/xfer3.zip" ./* ) || fail "xfer-3: fixture zip creation failed"
  xfer_push "$OUT/xfer3.zip" "xfer3.zip"
  restart; adb logcat -c
  adb shell am start -n "$PKG/.MainActivity" --ez xfer_test true --es xfer_uri "$XURI_BASE/xfer3.zip" >/dev/null 2>&1 || fail "xfer-3: am start"
  sleep 8
  capture xfer-3
  xfer_evidence xfer-3
  grep -q "G1XFER.*registry sha mismatch" "$OUT/xfer-3.logcat" 2>/dev/null || fail "xfer-3: registry rejection not evidenced"
  adb shell "run-as $PKG sh -c 'ls files/asr/ 2>/dev/null | grep -q asr.onnx'" && fail "xfer-3: registry-rejected file WAS staged"
  assert_alive xfer-3; assert_no_crash xfer-3 "$OUT/xfer-3.logcat"

  # xfer-4: NO manifest -> whole package refused with the owner-facing message.
  local N="$STG/v4"; mkdir -p "$N"
  printf 'somefile' > "$N/featspec.json"
  ( cd "$N" && zip -q "$OUT/xfer4.zip" ./* ) || fail "xfer-4: fixture zip creation failed"
  xfer_push "$OUT/xfer4.zip" "xfer4.zip"
  restart; adb logcat -c
  adb shell am start -n "$PKG/.MainActivity" --ez xfer_test true --es xfer_uri "$XURI_BASE/xfer4.zip" >/dev/null 2>&1 || fail "xfer-4: am start"
  sleep 6
  capture xfer-4
  xfer_evidence xfer-4
  T4="$(ui_text)"; printf '%s' "$T4" >"$OUT/xfer-4-ui.xml"
  echo "$T4" | grep -q "manifest.json በፓኬጁ ውስጥ የለም" || fail "xfer-4: missing-manifest refusal message not shown"
  assert_alive xfer-4; assert_no_crash xfer-4 "$OUT/xfer-4.logcat"

  # xfer-5: OPTIONAL Oromo TTS accepted (ormTts=true) — the GAP closure path.
  local O="$STG/v5"; mkdir -p "$O"
  printf 'fixture-orm' > "$O/vits-orm.onnx"
  mk_manifest "$O" "$O/manifest.json"
  ( cd "$O" && zip -q "$OUT/xfer5.zip" ./* ) || fail "xfer-5: fixture zip creation failed"
  xfer_push "$OUT/xfer5.zip" "xfer5.zip"
  restart; adb logcat -c
  adb shell am start -n "$PKG/.MainActivity" --ez xfer_test true --es xfer_uri "$XURI_BASE/xfer5.zip" >/dev/null 2>&1 || fail "xfer-5: am start"
  sleep 8
  capture xfer-5
  xfer_evidence xfer-5
  grep -q "G1XFER.*ok=1 fail=5" "$OUT/xfer-5.logcat" 2>/dev/null || fail "xfer-5: unexpected outcome (expected ok=1 [vits-orm staged] + 5 required-missing reported)"
  grep -q "G1XFER.*ormTts=true" "$OUT/xfer-5.logcat" 2>/dev/null || fail "xfer-5: optional orm model not accepted/staged"
  assert_alive xfer-5; assert_no_crash xfer-5 "$OUT/xfer-5.logcat"

  # cleanup probe zips so later cases see a clean app dir
  for n in 1 2 3 4 5; do adb shell "run-as $PKG sh -c 'rm -f files/xfer$n.zip'" >/dev/null 2>&1 || true; done

  echo "NOTE xfergate: the APP half of the transfer solution is verified (manifest verification, tamper refusal, registry refusal with an exact-size fixture, missing-manifest refusal, optional-orm acceptance + GAP reporting). CI fixtures are bytes, NOT weights — a full ok=5 import can only happen with the owner's real zip (double-click tools/prepare-g1-models.bat) on the A53; that result lands on the device, not in CI."
}

case_launch() {
  OUT="$OUT_BASE/launch"; mkdir -p "$OUT"
  adb logcat -c
  adb shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1 || fail "launch: am start"
  sleep 25
  capture launch
  assert_alive launch
  assert_no_crash launch "$OUT/launch.logcat"
  assert_no_anr launch "$OUT/launch.logcat"
  assert_no_lmk launch "$OUT/launch.logcat"
  T="$(ui_text)"; printf '%s' "$T" >"$OUT/launch-ui.xml"
  ok "launch: app alive, no crash/ANR/LMK"
}

case_keyoff() {
  OUT="$OUT_BASE/keyoff"; mkdir -p "$OUT"
  restart; adb logcat -c
  adb shell am start -n "$PKG/.MainActivity" --ez tts_test true --ez ai_key_on false >/dev/null 2>&1 || fail "17-1: am start"
  sleep 12
  capture 17-1
  if grep -q "G1TTS" "$OUT/17-1.logcat" 2>/dev/null; then fail "17-1: TTS activity with key OFF"; fi
  assert_alive 17-1; assert_no_crash 17-1 "$OUT/17-1.logcat"
  restart; adb logcat -c
  adb shell am start -n "$PKG/.MainActivity" --ez mic_test true --ez ai_key_on false >/dev/null 2>&1 || fail "17-2: am start"
  sleep 12
  capture 17-2
  if grep -q "G1AUDIO" "$OUT/17-2.logcat" 2>/dev/null; then fail "17-2: mic activity with key OFF"; fi
  assert_alive 17-2; assert_no_crash 17-2 "$OUT/17-2.logcat"
  restart; adb logcat -c
  adb shell am start -n "$PKG/.MainActivity" --ez tts_test true >/dev/null 2>&1 || fail "17-3: am start"
  sleep 15
  capture 17-3
  grep -q "tts/vits.onnx" "$OUT/17-3.logcat" 2>/dev/null || fail "17-3: vits.onnx load attempt not evidenced"
  grep -q "TTS FAILED" "$OUT/17-3.logcat" 2>/dev/null || fail "17-3: TTS failure marker missing"
  assert_alive 17-3; assert_no_crash 17-3 "$OUT/17-3.logcat"; assert_no_anr 17-3 "$OUT/17-3.logcat"
  echo "NOTE 17-3: key-ON control attempted TTS and failed at missing asset tts/vits.onnx — model gap confirmed at runtime. D-QA-19 stays BLOCKED until the owner stages the approved MMS VITS model."
}

case_asrgate() {
  OUT="$OUT_BASE/asrgate"; mkdir -p "$OUT"
  restart; adb logcat -c
  adb shell am start -n "$PKG/.MainActivity" --ez asr_test true >/dev/null 2>&1 || fail "asrgate-on: am start"
  sleep 12
  capture asrgate-on
  grep -q "G1ASRTEST" "$OUT/asrgate-on.logcat" 2>/dev/null || fail "asrgate-on: ASR callback did not fire (no G1ASRTEST log)"
  grep -q "ASR model not staged" "$OUT/asrgate-on.logcat" 2>/dev/null || fail "asrgate-on: engine attempt not evidenced (expected not-staged failure — models are not in the repo)"
  if grep -q "AudioTrack played" "$OUT/asrgate-on.logcat" 2>/dev/null; then fail "asrgate-on: echo playback ran after ASR callback (unwanted audio feedback path — v18 regression)"; fi
  assert_alive asrgate-on; assert_no_crash asrgate-on "$OUT/asrgate-on.logcat"; assert_no_anr asrgate-on "$OUT/asrgate-on.logcat"
  restart; adb logcat -c
  adb shell am start -n "$PKG/.MainActivity" --ez asr_test true --ez ai_key_on false >/dev/null 2>&1 || fail "asrgate-off: am start"
  sleep 8
  capture asrgate-off
  if grep -q "G1ASRTEST" "$OUT/asrgate-off.logcat" 2>/dev/null; then fail "asrgate-off: ASR activity with key OFF"; fi
  if grep -q "G1AUDIO" "$OUT/asrgate-off.logcat" 2>/dev/null; then fail "asrgate-off: mic activity with key OFF"; fi
  assert_alive asrgate-off; assert_no_crash asrgate-off "$OUT/asrgate-off.logcat"
  echo "NOTE asrgate: mic->ASR callback wiring + key gate verified. ASR inference NOT PASS — approved fp32 model + external-data companion not staged in CI; owner stages on device."
}

case_voicegate() {
  OUT="$OUT_BASE/voicegate"; mkdir -p "$OUT"
  restart; adb logcat -c
  adb shell am start -n "$PKG/.MainActivity" --ez voice_test true >/dev/null 2>&1 || fail "voicegate-on: am start"
  sleep 14
  capture voicegate-on
  grep -q "voice-turn-start" "$OUT/voicegate-on.logcat" 2>/dev/null || fail "voicegate-on: voice loop did not start (no G1PERF turn-start log)"
  grep -q "G1VOICE" "$OUT/voicegate-on.logcat" 2>/dev/null || fail "voicegate-on: no G1VOICE chain log (ASR engine attempt not evidenced)"
  grep -q "ASR model not staged" "$OUT/voicegate-on.logcat" 2>/dev/null || fail "voicegate-on: expected not-staged gate not reached (models are not in the repo — chain must fail exactly here)"
  grep -q "ASR FAILED — voice loop stops" "$OUT/voicegate-on.logcat" 2>/dev/null || fail "voicegate-on: loop stop marker missing (must stop LOUDLY at the model gate, not silently)"
  if grep -q "AudioTrack played" "$OUT/voicegate-on.logcat" 2>/dev/null; then fail "voicegate-on: echo playback ran in voice-loop mode (unwanted audio feedback — v18 discipline)"; fi
  assert_alive voicegate-on; assert_no_crash voicegate-on "$OUT/voicegate-on.logcat"; assert_no_anr voicegate-on "$OUT/voicegate-on.logcat"
  restart; adb logcat -c
  adb shell am start -n "$PKG/.MainActivity" --ez voice_test true --ez ai_key_on false >/dev/null 2>&1 || fail "voicegate-off: am start"
  sleep 8
  capture voicegate-off
  if grep -q "voice-turn-start" "$OUT/voicegate-off.logcat" 2>/dev/null; then fail "voicegate-off: voice loop started with key OFF"; fi
  if grep -q "G1VOICE" "$OUT/voicegate-off.logcat" 2>/dev/null; then fail "voicegate-off: voice chain activity with key OFF"; fi
  assert_alive voicegate-off; assert_no_crash voicegate-off "$OUT/voicegate-off.logcat"
  echo "NOTE voicegate: continuous voice-loop WIRING verified (mic→ASR→LLM→TTS chain code + key gate + clean stop at model gates). Real conversation PASS requires owner-staged models (asr.onnx+companion+vocab+featspec, qwen.gguf, vits.onnx) on device."
}

case_smsgate() {
  OUT="$OUT_BASE/smsgate"; mkdir -p "$OUT"
  otp_self_check
  restart; adb logcat -c
  adb shell am start -n "$PKG/.MainActivity" --ez sms_test true >/dev/null 2>&1 || fail "smsgate-on: am start"
  sleep 10
  capture smsgate-on
  grep -q "sms_test: inbox empty" "$OUT/smsgate-on.logcat" 2>/dev/null || fail "smsgate-on: read-on-request path not evidenced (expected: inbox-empty evidence line)"
  assert_alive smsgate-on; assert_no_crash smsgate-on "$OUT/smsgate-on.logcat"; assert_no_anr smsgate-on "$OUT/smsgate-on.logcat"
  restart; adb logcat -c
  adb shell am start -n "$PKG/.MainActivity" --ez sms_test true --ez ai_key_on false >/dev/null 2>&1 || fail "smsgate-off: am start"
  sleep 8
  capture smsgate-off
  grep -q "sms_test refused — guard denial (no query made)" "$OUT/smsgate-off.logcat" 2>/dev/null || fail "smsgate-off: refusal evidence line missing (must refuse with NO query)"
  if grep -q "sms_test: read-on-request exercised" "$OUT/smsgate-off.logcat" 2>/dev/null; then fail "smsgate-off: SMS was queried with key OFF (privacy violation)"; fi
  assert_alive smsgate-off; assert_no_crash smsgate-off "$OUT/smsgate-off.logcat"
  echo "NOTE smsgate: consent-gated read-on-request + key-OFF refusal + OTP-classifier (real source) verified. Real-device message content NEVER tested in CI (privacy)."
}

case_ramguard() {
  OUT="$OUT_BASE/ramguard"; mkdir -p "$OUT"
  echo "-- 20-1: staging 1536MiB stub at files/models/qwen.gguf via run-as --"
  # repair round: the 1536 MiB dd on the emulator is bounded at 600s (it is the
  # slowest legitimate single adb call in the suite).
  adb_xslow shell "run-as $PKG sh -c 'mkdir -p files/models && dd if=/dev/zero of=files/models/qwen.gguf bs=1048576 count=1536 status=none'" >"$OUT/20-1-stub.log" 2>&1 \
    || { echo "-- 20-1 stub staging output --"; cat "$OUT/20-1-stub.log"; fail "20-1: stub staging (failed or TIMEOUT at ${ADB_XSLOW_TIMEOUT_S:-600}s)"; }
  echo "-- 20-1 staged file evidence (must be ~1610612736 bytes) --"
  adb shell "run-as $PKG ls -l files/models/qwen.gguf" || true
  restart; adb logcat -c
  adb shell am start -n "$PKG/.MainActivity" --ez autorun true >/dev/null 2>&1 || fail "20-1: am start"
  sleep 20
  capture 20-1
  grep -q "G1RAM" "$OUT/20-1.logcat" 2>/dev/null || fail "20-1: G1RAM log missing"
  grep -q "allowed=false" "$OUT/20-1.logcat" 2>/dev/null || fail "20-1: G1RAM allowed=false not logged"
  if adb shell ps -A 2>/dev/null | grep -qi "llama"; then fail "20-1: llama started despite RAM deny"; fi
  T="$(ui_text)"; printf '%s' "$T" >"$OUT/20-1-ui.xml"
  echo "$T" | grep -q "ማህደረ ትውስታ" || fail "20-1: deny status not shown"
  assert_alive 20-1; assert_no_anr 20-1 "$OUT/20-1.logcat"; assert_no_lmk 20-1 "$OUT/20-1.logcat"
  adb shell "run-as $PKG sh -c 'rm -f files/models/qwen.gguf'" >/dev/null 2>&1 || true
  restart; adb logcat -c
  adb shell am start -n "$PKG/.MainActivity" --ez autorun true >/dev/null 2>&1 || fail "20-2: am start"
  sleep 20
  capture 20-2
  grep -q "allowed=true" "$OUT/20-2.logcat" 2>/dev/null || fail "20-2: G1RAM allowed=true not logged"
  T="$(ui_text)"; printf '%s' "$T" >"$OUT/20-2-ui.xml"
  echo "$T" | grep -q "ሞዴል አልተገኘም" || fail "20-2: model-missing status not shown"
  assert_alive 20-2; assert_no_anr 20-2 "$OUT/20-2.logcat"; assert_no_lmk 20-2 "$OUT/20-2.logcat"
  echo "NOTE 20-2: allow path verified. Full llama inference NOT tested — the real Qwen3-4B-Q4_K_M.gguf is not in the repo; owner stages it on the device."
}

case_callgate() {
  OUT="$OUT_BASE/callgate"; mkdir -p "$OUT"
  restart; adb logcat -c
  adb shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1 || fail "callgate: am start"
  sleep 12
  adb emu gsm call 0911111111 >/dev/null 2>&1 || fail "callgate: gsm call injection failed"
  # in-call: bounded poll instead of one fixed sleep (telephony callback/UI can lag)
  T=""
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    sleep 1
    T="$(ui_text_once)"
    echo "$T" | grep -q "ጥሪ አለ" && break
  done
  printf '%s' "$T" >"$OUT/call-ui.xml"
  echo "$T" | grep -q "ጥሪ አለ" || fail "callgate: in-call status not shown"
  adb emu gsm cancel 0911111111 >/dev/null 2>&1 || true
  # post-call: bounded poll; a stale/missing uiautomator dump can no longer pass/fail wrongly
  T=""
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    sleep 1
    T="$(ui_text_once)"
    echo "$T" | grep -q "ጥሪ አልቀረም" && break
  done
  printf '%s' "$T" >"$OUT/cancel-ui.xml"
  capture callgate
  adb shell dumpsys telephony.registry >"$OUT/callgate-telephony.txt" 2>/dev/null || true
  echo "$T" | grep -q "ጥሪ አልቀረም" || fail "callgate: post-call status not shown"
  assert_alive callgate; assert_no_anr callgate "$OUT/callgate.logcat"; assert_no_crash callgate "$OUT/callgate.logcat"
  echo "NOTE 18-1: call-state listener verified with a real injected call. Audio-interrupt-during-playback stays BLOCKED until vits.onnx exists."
}

run_case() {
  local c="$1"
  echo "== case: $c =="
  case "$c" in
    launch)   case_launch ;;
    keyoff)   case_keyoff ;;
    asrgate)  case_asrgate ;;
    voicegate) case_voicegate ;;
    smsgate)   case_smsgate ;;
    xfergate)  case_xfergate ;;
    ramguard) case_ramguard ;;
    callgate) case_callgate ;;
    *) fail "unknown case: $c" ;;
  esac
  echo "CASE_RESULT $c PASS" >>"$OUT_BASE/results.txt"
}

if [ "$CASE" = "all" ]; then
  CASES="${RUNTIME_CASES:-launch keyoff asrgate voicegate smsgate xfergate ramguard callgate}"
  rm -f "$OUT_BASE/results.txt" "$OUT_BASE/failures.txt"
  # repair round: self-describing evidence header so the always-uploaded artifact is
  # readable with no external context, even if the run dies before case 1.
  {
    echo "# G1 runtime verification evidence"
    echo "commit=${GITHUB_SHA:-unknown}"
    echo "branch=${GITHUB_REF_NAME:-unknown}"
    echo "run_id=${GITHUB_RUN_ID:-local}"
    echo "started_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "cases=$CASES"
    echo "bounds_s: adb=${TIMEOUT_S_DEFAULT} fast=${ADB_FAST_TIMEOUT_S:-15} slow=${ADB_SLOW_TIMEOUT_S:-300} xslow=${ADB_XSLOW_TIMEOUT_S:-600} boot=${BOOT_LIMIT_S:-900}"
  } >>"$OUT_BASE/results.txt"
  boot_emulator
  install_apk
  FAILURES=0
  for c in $CASES; do
    if ( run_case "$c" ); then
      :
    else
      echo "CASE_RESULT $c FAIL" >>"$OUT_BASE/results.txt"
      FAILURES=$((FAILURES+1))
    fi
  done
  kill "$EMU_PID" 2>/dev/null || true
  if [ "$FAILURES" -eq 0 ]; then
    echo "OVERALL PASS cases=$(printf '%s' "$CASES" | wc -w)" >>"$OUT_BASE/results.txt"
  else
    echo "OVERALL FAIL cases_failed=$FAILURES" >>"$OUT_BASE/results.txt"
  fi
  echo "== results =="
  cat "$OUT_BASE/results.txt" || true
  if [ -f "$OUT_BASE/failures.txt" ]; then echo "== failures =="; cat "$OUT_BASE/failures.txt"; fi
  [ "$FAILURES" -eq 0 ] || fail "$FAILURES runtime case(s) failed"
  ok "all runtime cases passed"
else
  OUT="$OUT_BASE/$CASE"; mkdir -p "$OUT"
  boot_emulator
  install_apk
  run_case "$CASE"
  kill "$EMU_PID" 2>/dev/null || true
  ok "case $CASE complete"
fi
