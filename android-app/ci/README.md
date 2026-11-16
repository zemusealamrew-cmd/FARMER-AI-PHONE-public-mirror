# builder3 CI files (v2.12-wip)

- `build-apk.sh` — Linux port of `build-apk.ps1`; produces the signed APK (Run 5 SUCCESS).
- `workflow.yml` — APK build workflow SOURCE (installed at `.github/workflows/build-apk.yml`).
  Repair round 2026-11-13: triggers `[ci-build-apk-20261112, g1/repair-20261113]` +
  workflow_dispatch; job timeout 60 min, Build APK step timeout 30 min; runtime evidence
  (`rt-out/`) uploaded with `if: always()` as artifact `g1-runtime-evidence` (14 days);
  APK artifact remains success-only.
- `runtime-test.sh` — G1 runtime verification on a GitHub Actions Android emulator
  (KVM, x86_64 API 34). Strict assertions: job conclusion IS the case verdict.
- `workflow-runtime.yml` — runtime verification workflow definition. To activate, copy to
  `.github/workflows/runtime.yml` (same procedure the owner used for the build workflow).
  Cases: `launch`, `keyoff` (D-QA-17-1/2/3 + vits.onnx gap evidence), `ramguard`
  (D-QA-20-1 deny + 20-2 allow control), `callgate` (D-QA-18 listener with real
  `adb emu gsm call` injection).

## Status labels (no PASS without a completed run)

- D-QA-17-1/2/3: PENDING-RUN (job `keyoff`)
- D-QA-18 (listener): PENDING-RUN (job `callgate`); audio-interrupt-during-playback part BLOCKED (needs vits.onnx)
- D-QA-19 (>3s TTS playback): BLOCKED — `android-app/assets/tts/vits.onnx` missing; the approved MMS VITS model must be provided by the owner (repo excludes model binaries per `.gitignore`)
- D-QA-20-1/2: PENDING-RUN (job `ramguard`)
- ASR on-device + WER/CER: BLOCKED — no reference transcripts; full fp32 ASR load is BLOCKED on 2.5GB devices (Builder 2 evidence `e9a2fbdc`); Gemma full inference needs the owner-provided gemma.gguf on the device
- Offline voice->AI->voice end-to-end: BLOCKED — requires the models above
