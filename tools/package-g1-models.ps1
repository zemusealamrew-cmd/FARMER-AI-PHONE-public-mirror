# package-g1-models.ps1 — builder3 v30
# G1 OWNER-SIDE MODEL PACKAGING TOOL (runs on the OWNER'S Windows machine).
#
# PURPOSE (owner order 2026-11-13): the ASR/TTS local-export files exist ONLY on this
# machine and have no public download URL (verified: HF file lists hold safetensors,
# not these ONNX exports). The phone (Samsung A53) cannot be connected via USB, so the
# ONLY viable path is: package everything into ONE zip -> owner transfers it to the phone
# by their own PRIVATE channel -> the app's "Transfer Package" import verifies and stages
# every file in one tap. Internet is NOT used for the import.
#
# THIS SCRIPT NEVER UPLOADS ANYTHING. It only creates a local zip.
#
# v30 FIX: all source paths are resolved from the REPOSITORY ROOT (parent of tools\)
# instead of the current working directory — so double-clicking tools\prepare-g1-models.bat
# works regardless of where Explorer's CWD sits. The zip lands in the repo root.
#
# WHAT IT DOES:
#   1. Locates the approved local-export files (edit the paths below if different):
#        asr.onnx, asr.onnx.data, featspec.json, vocab.json   (ASR export)
#        vits.onnx                                            (Amharic TTS export)
#        vits-orm.onnx + vocab-orm.json                       (Oromo TTS — OPTIONAL)
#   2. Computes SHA-256 + size for EVERY file and writes manifest.json into the zip.
#      The app verifies every file against this manifest (and the three registry-pinned
#      files against model_registry hashes too) — nothing unverified is ever staged.
#   3. Writes g1-models-transfer.zip in the project root.
#
# OROMO TTS GAP CLOSURE: run tools\export-orm-tts.py first (same venv as the Amharic
# export) so vits-orm.onnx + vocab-orm.json exist — then this script includes them and
# the phone speaks Afaan Oromo replies (the app picks the model by the ASR language tag).
#
# USAGE: double-click tools\prepare-g1-models.bat  (or run this file directly).

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot

# ---- EDIT THESE PATHS IF YOUR LAYOUT DIFFERS -----------------------------------------------
$AsrExportDir = Join-Path $RepoRoot "research\onnx-export-20261111"        # asr.onnx + asr.onnx.data + featspec.json
$AsrVocab     = Join-Path $RepoRoot "badrex--Ethio-ASR-multilingual-600M\vocab.json"  # ASR vocab (5,601 B)
$TtsAmh       = Join-Path $AsrExportDir "mms-tts-amh-vits-nonoise.onnx"
$TtsOrm       = Join-Path $AsrExportDir "mms-tts-orm-vits-nonoise.onnx"  # optional
$TtsOrmVocab  = Join-Path $RepoRoot "facebook--mms-tts-orm\vocab.json"       # optional (with vits-orm.onnx)
# --------------------------------------------------------------------------------------------

$OutZip = Join-Path $RepoRoot "g1-models-transfer.zip"
$Stage  = Join-Path $PSScriptRoot "g1-models-stage"
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Path $Stage | Out-Null

$files = New-Object System.Collections.ArrayList

function Add-File($path, $zipName, $required) {
  if (-not (Test-Path $path)) {
    if ($required) { Write-Host "MISSING REQUIRED FILE: $path" -ForegroundColor Red; exit 1 }
    Write-Host "optional file not found (skipped): $path" -ForegroundColor Yellow
    return
  }
  $sha = (Get-FileHash -Algorithm SHA256 $path).Hash.ToLower()
  $bytes = (Get-Item $path).Length
  Copy-Item $path (Join-Path $Stage $zipName)
  [void]$files.Add(@{ name = $zipName; bytes = $bytes; sha256 = $sha })
  Write-Host ("PACKED  {0}  {1:N0} bytes  sha256={2}" -f $zipName, $bytes, $sha.Substring(0,16))
}

Write-Host "== G1 model transfer packaging =="
Add-File (Join-Path $AsrExportDir "asr.onnx")       "asr.onnx"       $true
Add-File (Join-Path $AsrExportDir "asr.onnx.data") "asr.onnx.data"  $true
Add-File (Join-Path $AsrExportDir "featspec.json") "featspec.json"  $true
Add-File $AsrVocab "vocab.json" $true
Add-File $TtsAmh   "vits.onnx"   $true
Add-File $TtsOrm       "vits-orm.onnx"  $false   # optional — Oromo TTS
Add-File $TtsOrmVocab  "vocab-orm.json" $false   # optional — Oromo TTS vocab

if ($files.Count -lt 5) { Write-Host "Incomplete file set — aborting." -ForegroundColor Red; exit 1 }

$manifest = @{ schema = 1; files = $files } | ConvertTo-Json -Depth 4
$manifest | Out-File -Encoding ascii (Join-Path $Stage "manifest.json")
Write-Host "manifest.json written (SHA-256 for every file — the app verifies against it)."

if (Test-Path $OutZip) { Remove-Item -Force $OutZip }
Compress-Archive -Path (Join-Path $Stage "*") -DestinationPath $OutZip
Write-Host ""
Write-Host ("DONE: {0}" -f $OutZip) -ForegroundColor Green
Write-Host ""
Write-Host "NEXT (owner, PRIVATE channel only — never upload this to a public store):"
Write-Host "  1. Send g1-models-transfer.zip to the phone by your own private means"
Write-Host "     (e.g. messaging-to-self, private cloud, SD card)."
Write-Host "  2. On the phone: open the G1 app -> 'Model Import' -> 'Transfer Package (g1-models.zip)'"
Write-Host "     and pick the zip. The app verifies every file (size + SHA-256) and stages all"
Write-Host "     models in one step. Internet is NOT used for the import."
Write-Host "  3. Then 'Start Conversation (Voice)' works fully offline (airplane mode on)."
