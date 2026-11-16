param()
$Sdk='C:\Users\DY Group\AppData\Local\Android\Sdk'
$Jdk='C:\Program Files\Android\Android Studio1\jbr'
$bt=Join-Path $Sdk 'build-tools/36.1.0'
$androidJar=Join-Path $Sdk 'platforms/android-35/android.jar'
$proj='C:\\Users\\DY Group\\OneDrive\\Documents\\deepseek-harness\\default-workspace\\farmer-g1-integration\\android-app'
$work=Join-Path $proj 'build'
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Path $work | Out-Null
$env:JAVA_HOME=$Jdk; $env:PATH=(Join-Path $Jdk 'bin')+';'+$bt+';'+$env:PATH
& (Join-Path $bt 'aapt2.exe') link -o (Join-Path $work 'base.apk') -I $androidJar --manifest (Join-Path $proj 'AndroidManifest.xml') -A (Join-Path $proj 'assets')
if ($LASTEXITCODE -ne 0) { throw 'aapt2 failed' }
$classes=Join-Path $work 'classes'; New-Item -ItemType Directory -Path $classes | Out-Null
& (Join-Path $Jdk 'bin/javac.exe') -source 17 -target 17 -classpath "$androidJar;$proj/ort/classes.jar" -d $classes (Get-ChildItem (Join-Path $proj 'src') -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }
$dex=Join-Path $work 'dex'; New-Item -ItemType Directory -Path $dex | Out-Null
$classFiles=@(); $classFiles += (Get-ChildItem (Join-Path $classes 'phone/farmer/g1ai') -Filter '*.class' | ForEach-Object { $_.FullName }); $ortJar=Join-Path $proj 'ort/classes.jar'; if (Test-Path $ortJar) { $classFiles += $ortJar }
& (Join-Path $bt 'd8.bat') --lib $androidJar --output $dex @classFiles
if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }
# verify jni sources exist
foreach ($abi in @('x86_64','arm64-v8a')) {
  $dir = Join-Path $proj ('jni/' + $abi)
  if (-not (Test-Path (Join-Path $dir 'libllama-cli.so'))) { throw ('missing libllama-cli.so for ' + $abi) }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[System.IO.Compression.ZipFile]::Open((Join-Path $work 'base.apk'),'Update')
$entry=$zip.CreateEntry('classes.dex'); $st=$entry.Open(); $bytes=[System.IO.File]::ReadAllBytes((Join-Path $dex 'classes.dex')); $st.Write($bytes,0,$bytes.Length); $st.Close()
foreach ($abi in @('x86_64','arm64-v8a')) {
  $dir = Join-Path $proj ('jni/' + $abi)
  Get-ChildItem $dir -File | ForEach-Object { $e=$zip.CreateEntry('lib/' + $abi + '/' + $_.Name); $s2=$e.Open(); $bb=[System.IO.File]::ReadAllBytes($_.FullName); $s2.Write($bb,0,$bb.Length); $s2.Close() }
}
$zip.Dispose()
& (Join-Path $bt 'zipalign.exe') -f 4 (Join-Path $work 'base.apk') (Join-Path $work 'aligned.apk')
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }
& (Join-Path $bt 'zipalign.exe') -c 4 (Join-Path $work 'aligned.apk')
if ($LASTEXITCODE -ne 0) { throw 'zipalign check failed' }
$ks=Join-Path $proj 'debug.keystore'
if (-not (Test-Path $ks)) { & (Join-Path $Jdk 'bin/keytool.exe') -genkeypair -keystore $ks -storepass android -keypass android -alias androiddebugkey -dname 'CN=G1,O=Farmer AI Phone,C=ET' -keyalg RSA -keysize 2048 -validity 10000 2>&1 | Out-Null }
$final=Join-Path $proj 'g1-amharic-ai-debug.apk'
if (Test-Path $final) { Remove-Item $final -Force }
& (Join-Path $bt 'apksigner.bat') sign --ks $ks --ks-pass pass:android --key-pass pass:android --out $final (Join-Path $work 'aligned.apk')
if ($LASTEXITCODE -ne 0) { throw 'sign failed' }
& (Join-Path $bt 'apksigner.bat') verify $final
if ($LASTEXITCODE -ne 0) { throw 'verify failed' }
$apkObj=Get-Item $final
$z2=[System.IO.Compression.ZipFile]::OpenRead($final)
$libCount=($z2.Entries | Where-Object { $_.FullName -like 'lib/*' }).Count
$z2.Dispose()
Write-Output ('lib_entries=' + $libCount)
if ($libCount -lt 2) { throw 'native libraries missing from signed APK' }
Write-Output ('APK ' + $final + ' bytes=' + $apkObj.Length + ' sha256=' + (Get-FileHash $final -Algorithm SHA256).Hash)
