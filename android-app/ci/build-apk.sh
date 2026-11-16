#!/usr/bin/env bash
# builder3 — Linux port of android-app/build-apk.ps1 for GitHub Actions (v2.12-wip).
# Produces a REAL, signed APK: aapt2 link -> javac -> d8 -> zip -> zipalign -> apksigner.
# v6: runtime verification gate fix — do NOT pre-check for the emulator binary here;
#     runtime-test.sh installs it via sdkmanager itself (the pre-check failed on
#     GitHub runners where the 'emulator' package is absent until runtime-test.sh
#     installs it).
# REPAIR ROUND 2026-11-13 (branch g1/repair-20261113) — CI robustness only:
#     the RUNTIME_SKIP escape was REMOVED. A CI invocation of this script now ALWAYS
#     executes runtime-test.sh, so a green run can never mean "build only".
#     runtime-test.sh bounds every external call (portable background+wait+kill
#     watchdog; GNU timeout is not assumed) and always writes rt-out evidence, which
#     the workflow uploads with if: always() (retention 14 days).
#     No build step, no model, no requirement, no architecture and no BUILD_TAG/
#     version change.
set -euo pipefail

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
BT="$SDK/build-tools/36.1.0"
AJAR="$SDK/platforms/android-35/android.jar"
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$PROJ/build"
rm -rf "$WORK"
mkdir -p "$WORK"

echo "== aapt2 link =="
"$BT/aapt2" link -o "$WORK/base.apk" -I "$AJAR" \
  --manifest "$PROJ/AndroidManifest.xml" -A "$PROJ/assets"
ls -l "$WORK/base.apk"

echo "== javac =="
mkdir -p "$WORK/classes"
mapfile -t SRCS < <(find "$PROJ/src" -name '*.java')
[ "${#SRCS[@]}" -gt 0 ] || { echo "no java sources found" >&2; exit 1; }
javac -source 17 -target 17 \
  -classpath "$AJAR:$PROJ/ort/classes.jar" \
  -d "$WORK/classes" "${SRCS[@]}"

echo "== d8 =="
mkdir -p "$WORK/dex"
mapfile -t CLS < <(find "$WORK/classes" -name '*.class')
[ "${#CLS[@]}" -gt 0 ] || { echo "no compiled classes" >&2; exit 1; }
if [[ -f "$PROJ/ort/classes.jar" ]]; then CLS+=("$PROJ/ort/classes.jar"); fi
"$BT/d8" --lib "$AJAR" --output "$WORK/dex" "${CLS[@]}"
ls -l "$WORK/dex"

echo "== verify jni libs =="
for ABI in x86_64 arm64-v8a; do
  [[ -f "$PROJ/jni/$ABI/libllama-cli.so" ]] || { echo "missing libllama-cli.so for $ABI" >&2; exit 1; }
done

echo "== pack =="
(cd "$WORK/dex" && zip -q "$WORK/base.apk" classes*.dex)
STAGE="$WORK/stage"
mkdir -p "$STAGE/lib"
for ABI in x86_64 arm64-v8a; do
  mkdir -p "$STAGE/lib/$ABI"
  cp "$PROJ/jni/$ABI"/*.so "$STAGE/lib/$ABI/"
  (cd "$STAGE" && zip -q "$WORK/base.apk" lib/"$ABI"/*.so)
done
unzip -l "$WORK/base.apk" | head -30

echo "== zipalign =="
"$BT/zipalign" -f 4 "$WORK/base.apk" "$WORK/aligned.apk"
"$BT/zipalign" -c 4 "$WORK/aligned.apk"

echo "== keystore =="
KS="$PROJ/debug.keystore"
if [[ ! -f "$KS" ]]; then
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias androiddebugkey -dname 'CN=G1,O=Farmer AI Phone,C=ET' \
    -keyalg RSA -keysize 2048 -validity 10000 >/dev/null 2>&1
fi

echo "== sign =="
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out "$PROJ/g1-amharic-ai-debug.apk" "$WORK/aligned.apk"
"$BT/apksigner" verify "$PROJ/g1-amharic-ai-debug.apk"

echo "== summary =="
LIBS=$(unzip -l "$PROJ/g1-amharic-ai-debug.apk" | grep -c 'lib/')
echo "lib_entries=$LIBS"
[[ "$LIBS" -ge 2 ]] || { echo "native libraries missing from signed APK" >&2; exit 1; }
ls -l "$PROJ/g1-amharic-ai-debug.apk"
echo "BUILD OK"

# --- G1 runtime verification — ALWAYS ON (repair round 2026-11-13: no skip path) ---
echo "== runtime verification (cases: ${RUNTIME_CASES:-launch keyoff asrgate voicegate smsgate xfergate ramguard callgate}) =="
bash "$PROJ/ci/runtime-test.sh" all
