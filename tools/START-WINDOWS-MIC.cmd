@echo off
setlocal
set "FARMER_NATIVE_MIC_DIR=%~dp0"
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo WINDOWS_POWERSHELL_NOT_FOUND
  pause
  exit /b 1
)
powershell.exe -NoProfile -STA -Command "$ErrorActionPreference='Stop'; $micStage='source-files'; $micCode='SOURCE_MISSING'; try { $micDir=$env:FARMER_NATIVE_MIC_DIR; $micCore=Join-Path $micDir 'windows-mic-core.cs'; $micUi=Join-Path $micDir 'windows-mic-ui.cs'; if (!(Test-Path -LiteralPath $micCore) -or !(Test-Path -LiteralPath $micUi)) { throw 'Source files missing' }; $micStage='compile-source'; $micCode='COMPILE_FAILED'; Add-Type -Path $micCore,$micUi -ReferencedAssemblies System.dll,System.Core.dll,System.Windows.Forms.dll,System.Drawing.dll; $micStage='windows-ui'; $micCode='WINDOWS_RUNTIME_FAILED'; [FarmerNativeMic.MainWindow]::Run() } catch { $micReport=@{stage=$micStage;code=$micCode;exception_type=$_.Exception.GetType().FullName;managed_hresult=$_.Exception.HResult;category=[string]$_.CategoryInfo.Category;ps_version=[string]$PSVersionTable.PSVersion;clr_version=[string]$PSVersionTable.CLRVersion;speech_verified=$false;audio_included=$false}; Write-Host 'WINDOWS_MIC_START_FAILED'; try { $micPath=Join-Path $env:TEMP ('FarmerAiMic-startup-'+[guid]::NewGuid().ToString('N')+'.json'); $micReport|ConvertTo-Json|Set-Content -LiteralPath $micPath -Encoding UTF8; Write-Host ('Metadata report: '+$micPath) } catch { Write-Host 'STARTUP_REPORT_WRITE_FAILED' }; Read-Host 'Press Enter to close'; exit 1 }"
endlocal
