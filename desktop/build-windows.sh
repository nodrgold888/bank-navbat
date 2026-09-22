#!/usr/bin/env bash
# Builds three tiny Windows .exe shortcuts (Operator/Admin/TV) that each
# open one panel of the web app in the browser — nothing else. The app
# itself stays a plain web app (wherever it already runs: Render, a PC
# on the LAN via `npm start`, etc.); no Node.js, no bundled server, no
# downloads on the target PC.
#
# Requirement on the build machine: mingw-w64.
#   Debian/Ubuntu: sudo apt-get install -y mingw-w64
#
# Usage: ./desktop/build-windows.sh
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="dist/DavrBank-PC"
rm -rf "$OUT"
mkdir -p "$OUT"

echo "== Compiling native launchers (mingw-w64) =="
x86_64-w64-mingw32-gcc -O2 -mwindows -DTARGET_PATH='"/staff"' \
  desktop/native/launcher_web.c -o "$OUT/DavrBank-Operator.exe" -lshell32
x86_64-w64-mingw32-gcc -O2 -mwindows -DTARGET_PATH='"/admin"' \
  desktop/native/launcher_web.c -o "$OUT/DavrBank-Admin.exe" -lshell32
x86_64-w64-mingw32-gcc -O2 -mwindows -DTARGET_PATH='"/tv"' -DKIOSK \
  desktop/native/launcher_web.c -o "$OUT/DavrBank-TV.exe" -lshell32

cp "desktop/O'QING.txt" "$OUT/O'QING.txt"

echo "== Done: $OUT =="
ls -lh "$OUT"
