#!/usr/bin/env bash
#
# Remove one instance from the server.
#
# Releases and configuration always go; the database and uploads only go with
# --purge, so a mistyped instance name cannot silently delete production data.
#
# usage: destroy.sh <instance> [--purge]
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_provisioned
[ "$(id -u)" -eq 0 ] || die "destroy must run as root"

INSTANCE=${1:-}; shift || true
[ -n "$INSTANCE" ] || die "usage: destroy.sh <instance> [--purge]"
PURGE=0
while [ $# -gt 0 ]; do
	case "$1" in
		--purge) PURGE=1; shift ;;
		*) die "unknown argument: $1" ;;
	esac
done

APP=$(app_dir "$INSTANCE")
ETC=$(etc_dir "$INSTANCE")

log "stopping services"
for unit in "$(unit_web "$INSTANCE")" "$(unit_pb "$INSTANCE")"; do
	systemctl disable --now "$unit" >/dev/null 2>&1 || true
done

log "removing routing"
rm -f "$VELA_ETC/caddy/$INSTANCE.caddy"
systemctl reload caddy >/dev/null 2>&1 || true

log "removing releases"
rm -rf "$APP/releases" "$APP/deps" "$APP/current" "$APP/bin"

if [ "$PURGE" = "1" ]; then
	log "purging data and configuration"
	rm -rf "$APP" "$ETC"
	release_ports "$INSTANCE"
else
	log "keeping $APP/shared (pass --purge to remove the database)"
	rm -f "$APP/state.json"
fi

find "$VELA_ROOT/by-name" -maxdepth 1 -type l ! -exec test -e {} \; -delete 2>/dev/null || true

emit_result --arg instance "$INSTANCE" --argjson purged "$PURGE" \
	'{instance: $instance, purged: ($purged == 1)}'
