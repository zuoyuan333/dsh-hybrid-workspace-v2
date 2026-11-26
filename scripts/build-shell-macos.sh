#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-${DSH_HOME:-$HOME/.dsh}/hybrid-workspace-v2/HybridWorkspaceShell.app}"
DEST="${DEST%/}"
case "$DEST" in
  *.app) ;;
  *) print -u2 -- "destination must be an .app bundle: $DEST"; exit 2 ;;
esac
case "$DEST" in
  /|"$HOME"|"") print -u2 -- "refusing unsafe destination: $DEST"; exit 2 ;;
esac

STAGE="${DEST}.build-$$.app"
BACKUP="${DEST}.backup-$$.app"
if [[ -e "$STAGE" || -L "$STAGE" || -e "$BACKUP" || -L "$BACKUP" ]]; then
  print -u2 -- "staging path already exists; refusing to overwrite"
  exit 2
fi
mkdir -p "$(dirname "$DEST")"
MACOS="$STAGE/Contents/MacOS"

cleanup () {
  if [[ -e "$STAGE" || -L "$STAGE" ]]; then rm -rf "$STAGE"; fi
  if [[ -e "$BACKUP" || -L "$BACKUP" ]]; then
    if [[ ! -e "$DEST" && ! -L "$DEST" ]]; then
      mv "$BACKUP" "$DEST" || print -u2 -- "could not restore previous app bundle from $BACKUP"
    fi
  fi
}
trap cleanup EXIT

mkdir -p "$MACOS" "$STAGE/Contents/Resources"

swiftc "$ROOT/shell/macos/main.swift" \
  -O -framework Cocoa -framework WebKit \
  -o "$MACOS/HybridWorkspaceShell"

cat > "$STAGE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>HybridWorkspaceShell</string>
  <key>CFBundleDisplayName</key><string>工作区控制台</string>
  <key>CFBundleIdentifier</key><string>com.zuoyuan.hybrid-workspace-shell</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>HybridWorkspaceShell</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$STAGE"

if [[ -e "$DEST" || -L "$DEST" ]]; then mv "$DEST" "$BACKUP"; fi
if ! mv "$STAGE" "$DEST"; then
  if [[ -e "$BACKUP" || -L "$BACKUP" ]]; then mv "$BACKUP" "$DEST"; fi
  print -u2 -- "could not install the completed app bundle"
  exit 1
fi
if [[ -e "$BACKUP" || -L "$BACKUP" ]]; then rm -rf "$BACKUP"; fi
trap - EXIT
printf '%s\n' "$DEST"
