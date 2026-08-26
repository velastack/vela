#!/usr/bin/env bash
#
# Put the previous release back for one instance.
#
# usage: rollback.sh <instance> [--to <release>]
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_provisioned
[ "$(id -u)" -eq 0 ] || die "rollback must run as root"

INSTANCE=${1:-}; shift || true
[ -n "$INSTANCE" ] || die "usage: rollback.sh <instance> [--to <release>]"

TARGET=""
while [ $# -gt 0 ]; do
	case "$1" in
		--to) TARGET=$2; shift 2 ;;
		*) die "unknown argument: $1" ;;
	esac
done

# Commands that drop to the app user inherit this working directory, and the
# directory the CLI happened to invoke from is usually one it cannot stat.
cd "$VELA_ROOT"

APP=$(app_dir "$INSTANCE")
[ -f "$(state_file "$INSTANCE")" ] || die "no instance $INSTANCE on this server"

CURRENT=$(state_get "$INSTANCE" activeRelease || echo "")
[ -n "$TARGET" ] || TARGET=$(state_get "$INSTANCE" previousRelease || echo "")
[ -n "$TARGET" ] || die "no previous release recorded for $INSTANCE"
[ -d "$APP/releases/$TARGET" ] || die "release $TARGET is no longer on disk"
[ "$TARGET" != "$CURRENT" ] || die "$TARGET is already the active release"

BACKEND=$(state_get "$INSTANCE" backend 2>/dev/null || echo "true")
HEALTH_PATH=$(state_get "$INSTANCE" healthCheckPath 2>/dev/null || echo "/")
WEB_PORT=$(state_get "$INSTANCE" webPort)
PB_PORT=$(state_get "$INSTANCE" pbPort)
WEB_UNIT=$(unit_web "$INSTANCE")
PB_UNIT=$(unit_pb "$INSTANCE")

log "rolling back to $TARGET"
systemctl stop "$WEB_UNIT" >/dev/null 2>&1 || true
if [ "$BACKEND" = "true" ]; then
	systemctl stop "$PB_UNIT" >/dev/null 2>&1 || true
	# Down migrations belong to the release being left behind, so they run from
	# the current release's migration set before the symlink moves.
	if [ -n "$CURRENT" ] && [ -d "$APP/releases/$CURRENT/migrations" ]; then
		AHEAD=$(migrations_ahead "$APP/releases/$CURRENT/migrations" "$APP/releases/$TARGET/migrations")
		if [ "$AHEAD" -gt 0 ]; then
			log "reverting $AHEAD migration(s) introduced after $TARGET"
			runuser -u "$VELA_USER" -- "$APP/bin/pocketbase" \
				--dir "$APP/shared/pb_data" \
				--migrationsDir "$APP/releases/$CURRENT/migrations" \
				migrate down "$AHEAD" >&2 \
				|| die "down migrations failed - the app is still stopped"
		fi
	fi
fi

ln -sfn "$APP/releases/$TARGET" "$APP/.current.tmp"
mv -Tf "$APP/.current.tmp" "$APP/current"

# The running release is part of the instance's environment, so it has to move
# with the symlink.
ETC=$(etc_dir "$INSTANCE")
if [ -f "$ETC/runtime.env" ]; then
	sed -i "s|^VELA_RELEASE=.*|VELA_RELEASE=$TARGET|" "$ETC/runtime.env"
fi

if [ "$BACKEND" = "true" ]; then
	systemctl restart "$PB_UNIT"
	wait_for_http "http://127.0.0.1:$PB_PORT/api/health" 60 0.5 \
		|| die "PocketBase did not become healthy after rollback"
fi
systemctl restart "$WEB_UNIT"
wait_for_http "http://127.0.0.1:$WEB_PORT$HEALTH_PATH" 60 0.5 \
	|| die "app did not become healthy after rollback"

state_merge "$INSTANCE" "$(jq -c -n --arg t "$TARGET" --arg c "$CURRENT" \
	--arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
	'{activeRelease: $t, previousRelease: $c, rolledBackAt: $at}')"

emit_result --arg release "$TARGET" --arg from "$CURRENT" '{release: $release, from: $from}'
