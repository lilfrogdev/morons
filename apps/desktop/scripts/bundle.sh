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
runtime="$bundle/Contents/Resources"
mkdir -p "$runtime/selfhost" "$runtime/review-runner"
cp -R ../../packages/selfhost/src "$runtime/selfhost/"
cp -R ../../packages/review-runner/src "$runtime/review-runner/"
cp -R ../../packages/selfhost/node_modules "$runtime/selfhost/"
for package in credential-store optchat visualization auth; do
  cp -R "../../packages/$package" "$runtime/"
done
printf '%s\n' "$PWD/$bundle"
