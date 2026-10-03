#!/bin/sh
# Build artifact hook; does not run the broker or install/open the application.
set -eu
umask 077
[ "$#" -eq 1 ] || { echo 'Usage: package-macos.sh <absolute build-artifact .app path>' >&2; exit 2; }
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo 'Requires macOS Apple Silicon' >&2; exit 2; }
case "$1" in /*.app) bundle="$1" ;; *) echo 'An absolute .app build-artifact path is required' >&2; exit 2 ;; esac
[ -d "$bundle/Contents" ] && [ ! -L "$bundle" ] && [ ! -L "$bundle/Contents" ] || { echo 'Existing regular app bundle required' >&2; exit 2; }
cd "$(dirname "$0")/.."
cargo build --locked --offline --release
for directory in "$bundle/Contents/Helpers" "$bundle/Contents/Resources" "$bundle/Contents/Resources/AuthBroker"; do
  [ ! -L "$directory" ] || { echo 'Symlinked package destination rejected' >&2; exit 2; }
  mkdir -p "$directory"
done
helper="$bundle/Contents/Helpers/morons-auth-broker"
manifest="$bundle/Contents/Resources/AuthBroker/broker.json"
[ ! -L "$helper" ] && [ ! -L "$manifest" ] || { echo 'Symlinked package destination rejected' >&2; exit 2; }
cp target/release/morons-auth-broker "$helper"
chmod 755 "$helper"
# Ad-hoc signing uses no identity/Keychain and is for local build artifacts.
# Distribution signing/notarization is a separate packaging-owner action.
/usr/bin/codesign --force --sign - --identifier dev.lilfrog.morons.auth-broker --timestamp=none "$helper"
/usr/bin/codesign --verify --strict "$helper"
cp LICENSE-SECURITY-FRAMEWORK-MIT LICENSE-SECURITY-FRAMEWORK-APACHE "$bundle/Contents/Resources/AuthBroker/"
digest=$(/usr/bin/shasum -a 256 "$helper" | /usr/bin/awk '{print $1}')
printf '{"version":1,"relativePath":"Contents/Helpers/morons-auth-broker","identifier":"dev.lilfrog.morons.auth-broker","signing":"adhoc","sha256":"%s"}\n' "$digest" > "$manifest"
printf '%s\n' "$helper"
