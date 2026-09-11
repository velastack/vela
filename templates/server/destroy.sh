#!/usr/bin/env bash
#
# Remove one instance from the server.
#
# Releases and configuration always go; the database and uploads only go with
# --purge, so a mistyped instance name cannot silently delete production data.
# A purge snapshots them into $VELA_ROOT/trash first, kept for two weeks.
#
# usage: destroy.sh <instance> [--purge] [--lock-wait <seconds>]
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_provisioned
[ "$(id -u)" -eq 0 ] || die "destroy must run as root"

INSTANCE=${1:-}; shift || true
[ -n "$INSTANCE" ] || die "usage: destroy.sh <instance> [--purge] [--lock-wait <seconds>]"
PURGE=0
LOCK_WAIT=300
while [ $# -gt 0 ]; do
	case "$1" in
		--purge) PURGE=1; shift ;;
		--lock-wait) LOCK_WAIT=$2; shift 2 ;;
		*) die "unknown argument: $1" ;;
	esac
done

require_instance_id "$INSTANCE"

APP=$(app_dir "$INSTANCE")
ETC=$(etc_dir "$INSTANCE")

lock_instance "$INSTANCE" "$LOCK_WAIT"

# Nothing to remove is a result, not an error: a preview that never deployed
# still gets a cleanup run when its pull request closes. Nothing is touched,
# so a mistyped name cannot do harm either way.
EXISTS=0
for path in "$APP/state.json" "$APP/releases" "$APP/current" "$ETC"; do
	if [ -e "$path" ]; then EXISTS=1; fi
done
if [ "$PURGE" = 1 ] && [ -d "$APP" ]; then EXISTS=1; fi
if [ "$EXISTS" = 0 ]; then
	log "nothing named $INSTANCE on this server"
	emit_result --arg instance "$INSTANCE" \
		'{instance: $instance, purged: false, existed: false}'
	exit 0
fi

log "stopping services"
for unit in "$(unit_web "$INSTANCE")" "$(unit_pb "$INSTANCE")"; do
	systemctl disable --now "$unit" >/dev/null 2>&1 || true
done

log "removing routing"
caddy_lock
rm -f "$VELA_ETC/caddy/$INSTANCE.caddy" "$VELA_ETC/caddy/routes/$INSTANCE.route"
caddy_reload || true
caddy_unlock

log "removing releases"
rm -rf "${APP:?}/releases" "${APP:?}/deps" "${APP:?}/current" "${APP:?}/bin"

SNAPSHOT=""
if [ "$PURGE" = "1" ]; then
	# The services are stopped, so the database is quiet: this is the one copy
	# of it that will exist once the purge runs. Root-only, pruned after two
	# weeks, and taken before anything is removed - a snapshot that fails
	# leaves the instance's data where it was.
	TRASH="$VELA_ROOT/trash"
	mkdir -p "$TRASH"
	chmod 0700 "$TRASH"
	find "$TRASH" -maxdepth 1 -name '*.tar.gz' -mtime +14 -delete 2>/dev/null || true
	members=()
	[ -d "$APP/shared" ] && members+=("${APP#/}/shared")
	[ -d "$ETC" ] && members+=("${ETC#/}")
	if [ "${#members[@]}" -gt 0 ]; then
		SNAPSHOT="$TRASH/$INSTANCE-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
		log "snapshotting data and configuration to $SNAPSHOT"
		tar -C / -czf "$SNAPSHOT" "${members[@]}" \
			|| die "could not snapshot $INSTANCE before purging - its data was left in place"
		chmod 0600 "$SNAPSHOT"
	fi
	log "purging data and configuration"
	rm -rf "${APP:?}" "${ETC:?}"
	release_ports "$INSTANCE"
else
	log "keeping $APP/shared (pass --purge to remove the database)"
	rm -f "$APP/state.json"
fi

find "$VELA_ROOT/by-name" -maxdepth 1 -type l ! -exec test -e {} \; -delete 2>/dev/null || true

emit_result --arg instance "$INSTANCE" --argjson purged "$PURGE" --arg trash "$SNAPSHOT" \
	'{instance: $instance, purged: ($purged == 1), existed: true, trash: $trash}'
