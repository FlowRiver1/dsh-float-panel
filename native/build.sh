#!/usr/bin/env bash
# Build "DSH Float Panel.app" next to this script. Re-run after editing main.swift.
set -euo pipefail
cd "$(dirname "$0")"

APP="DSH Float Panel.app"
BIN="dsh-float-panel"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

mkdir -p .build/module-cache
# Universal binary: build each slice, then glue them so the app runs natively
# on both Apple Silicon and Intel Macs.
build_slice() {
  swiftc -O -target "$1-apple-macos13.0" -module-cache-path "$PWD/.build/module-cache" \
    -o "$2" main.swift
}
build_slice arm64 .build/$BIN-arm64
if build_slice x86_64 .build/$BIN-x86_64 2>/dev/null; then
  lipo -create -output "$APP/Contents/MacOS/$BIN" ".build/$BIN-arm64" ".build/$BIN-x86_64"
else
  echo "warning: x86_64 slice unavailable, shipping arm64 only" >&2
  cp ".build/$BIN-arm64" "$APP/Contents/MacOS/$BIN"
fi

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleExecutable</key><string>dsh-float-panel</string>
  <key>CFBundleIdentifier</key><string>com.FlowRiver1.dsh-float-panel</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>DSH Float Panel</string>
  <key>CFBundleDisplayName</key><string>任务浮窗</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
echo "built: $PWD/$APP"
