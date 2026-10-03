#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo 'Requires macOS Apple Silicon' >&2; exit 1; }
cargo build --locked --release
bundle="target/release/Morons.app"
mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
cp target/release/morons-desktop "$bundle/Contents/MacOS/"
cp packaging/Info.plist "$bundle/Contents/"
cp NOTICE LICENSE-GPUI LICENSE-THIRD-PARTY ../../LICENSE "$bundle/Contents/Resources/"
printf '%s\n' "$PWD/$bundle"
