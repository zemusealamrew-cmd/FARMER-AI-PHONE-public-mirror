#!/bin/sh
set -eu
tools_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "${G1_REAL_PYTHON:-python3}" "$tools_directory/trace-offline-worker.py" "$@"
