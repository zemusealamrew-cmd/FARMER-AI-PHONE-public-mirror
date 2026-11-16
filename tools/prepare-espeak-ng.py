"""Explicit online preparation of pinned official Debian packages; Linux x86_64.
No binaries are committed. Distribution requires GPL notices and corresponding source.
"""
import hashlib,json,subprocess,urllib.request
from pathlib import Path
root=Path(__file__).resolve().parents[1]
profile=json.loads((root/'model_registry/espeak-ng-profile.json').read_text())
destination=root/'app/bin/espeak-ng';destination.mkdir(parents=True,exist_ok=True)
for package in profile['packages']:
    path=destination/package['url'].rsplit('/',1)[1]
    if not path.exists():
        with urllib.request.urlopen(package['url'],timeout=120) as source:path.write_bytes(source.read())
    if path.stat().st_size!=package['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest()!=package['sha256']:raise SystemExit('PACKAGE_HASH_MISMATCH')
    subprocess.run(['dpkg-deb','-x',str(path),str(destination)],check=True)
for item in profile['files']:
    path=destination/item['path']
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=item['sha256']:raise SystemExit('RUNTIME_HASH_MISMATCH')
print('Pinned eSpeak NG installed locally; GPL obligations and language quality acceptance remain separate.')
