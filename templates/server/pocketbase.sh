#!/usr/bin/env bash
#
# Ensure a given PocketBase version is available on this server and print its
# path. Versions live side by side so two apps can pin different ones and a
# rollback never has to downgrade a shared binary.
#
# usage: pocketbase.sh <version>
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

VERSION=${1:-}
[ -n "$VERSION" ] || die "pocketbase.sh needs a version"

DEST="$VELA_ROOT/runtime/pocketbase/$VERSION"
BIN="$DEST/pocketbase"

if [ -x "$BIN" ]; then
	printf '%s\n' "$BIN"
	exit 0
fi

case "$(uname -m)" in
	x86_64) NPM_PKG=pocketbase-server-linux-x64 ;;
	aarch64|arm64) NPM_PKG=pocketbase-server-linux-arm64 ;;
	*) die "unsupported architecture: $(uname -m)" ;;
esac

# The same npm package the CLI runs locally, so the server and a developer's
# machine are always on the identical PocketBase build.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
(
	cd "$tmp"
	npm init -y >/dev/null 2>&1
	npm install --no-audit --no-fund --loglevel=error "$NPM_PKG@$VERSION" >/dev/null
)
[ -f "$tmp/node_modules/$NPM_PKG/bin/pocketbase" ] \
	|| die "PocketBase $VERSION could not be installed from $NPM_PKG"

mkdir -p "$DEST"
install -m 0755 "$tmp/node_modules/$NPM_PKG/bin/pocketbase" "$BIN"
printf '%s\n' "$BIN"
