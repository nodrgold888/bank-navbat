#!/usr/bin/env bash
# Builds the Windows PC app (dist/DavrBank-PC) from Linux/macOS:
#   - 4 small native .exe launchers (Server, Operator, Admin, TV), compiled
#     with mingw-w64 from desktop/native/*.c
#   - the official Windows node.exe (downloaded from nodejs.org — no Node.js
#     install needed on the target PC)
#   - server.js, public/, desktop/*.js and production node_modules
#
# Requirements on the build machine: mingw-w64, npm, curl.
#   Debian/Ubuntu: sudo apt-get install -y mingw-w64
#
# Usage: ./desktop/build-windows.sh [node-version]
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_VERSION="${1:-24.21.0}"
OUT="dist/DavrBank-PC"
TMP="build-tmp"

echo "== Cleaning previous build =="
rm -rf "$TMP" "$OUT"
mkdir -p "$TMP" "$OUT"

echo "== Downloading Windows node.exe v$NODE_VERSION =="
curl -sSL -o "$TMP/node.exe" \
  "https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe"

echo "== Compiling native launchers (mingw-w64) =="
x86_64-w64-mingw32-gcc -O2 -mwindows \
  -DTARGET_SCRIPT='"desktop\\\\staff.js"' \
  desktop/native/launcher_gui.c -o "$TMP/DavrBank-Operator.exe"
x86_64-w64-mingw32-gcc -O2 -mwindows \
  -DTARGET_SCRIPT='"desktop\\\\admin.js"' \
  desktop/native/launcher_gui.c -o "$TMP/DavrBank-Admin.exe"
x86_64-w64-mingw32-gcc -O2 -mwindows \
  -DTARGET_SCRIPT='"desktop\\\\tv.js"' \
  desktop/native/launcher_gui.c -o "$TMP/DavrBank-TV.exe"
x86_64-w64-mingw32-gcc -O2 \
  desktop/native/launcher_console.c -o "$TMP/DavrBank-Server.exe"

echo "== Assembling $OUT =="
cp "$TMP"/node.exe "$TMP"/DavrBank-*.exe "$OUT"/
cp server.js "$OUT"/
cp -r public "$OUT"/
cp -r desktop "$OUT"/
mkdir -p "$OUT/data"
cat > "$OUT/package.json" <<'EOF'
{
  "name": "bank-navbat",
  "version": "1.0.0",
  "private": true,
  "main": "server.js",
  "dependencies": {
    "qrcode": "^1.5.4"
  }
}
EOF
(cd "$OUT" && npm install --omit=dev --no-audit --no-fund)
cp "desktop/O'QING.txt" "$OUT/O'QING.txt" 2>/dev/null || true
cp "desktop/1-Avval-shuni-bosing.bat" "$OUT/1-Avval-shuni-bosing.bat" 2>/dev/null || true

rm -rf "$TMP"
echo "== Done: $OUT =="
du -sh "$OUT"
