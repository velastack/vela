#!/usr/bin/env bash
#
# Replace one instance's database and uploads from a backup archive.
#
# This is the offline counterpart of PocketBase's own restore endpoint, which is
# not usable here for two reasons: it answers 204 and then does the work in a
# detached goroutine, so a failure is invisible to whoever asked for it; and it
# leaves the database holding whatever superuser the archive captured, while
# /etc/vela/apps/<instance>/env still holds the one the app signs in with on
# every render. Reconciling those is the whole reason this script exists.
#
# The old pb_data is renamed, never deleted. It is the only undo.
#
# usage: restore.sh <instance> --archive <path> [options]
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_provisioned
[ "$(id -u)" -eq 0 ] || die "restore must run as root"

INSTANCE=${1:-}; shift || true
[ -n "$INSTANCE" ] || die "usage: restore.sh <instance> --archive <path> [options]"

ARCHIVE=""
MIGRATE=1
KEEP_PREVIOUS=1
CLEANUP_ARCHIVE=0
HEALTH_PATH=""

while [ $# -gt 0 ]; do
	case "$1" in
		--archive) ARCHIVE=$2; shift 2 ;;
		--no-migrate) MIGRATE=0; shift ;;
		--keep-previous) KEEP_PREVIOUS=$2; shift 2 ;;
		--cleanup-archive) CLEANUP_ARCHIVE=1; shift ;;
		--health-path) HEALTH_PATH=$2; shift 2 ;;
		*) die "unknown argument: $1" ;;
	esac
done

[ -n "$ARCHIVE" ] || die "--archive is required"

# Commands that drop to the app user inherit this working directory, and the
# directory the CLI happened to invoke from is usually one it cannot stat.
cd "$VELA_ROOT"

require_backend "$INSTANCE"

APP=$(app_dir "$INSTANCE")
ETC=$(etc_dir "$INSTANCE")
PB_DATA="$APP/shared/pb_data"
WEB_UNIT=$(unit_web "$INSTANCE")
PB_UNIT=$(unit_pb "$INSTANCE")
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
PREVIOUS_DIR="$APP/shared/pb_data.pre-restore-$STAMP"

[ -d "$APP" ] || die "$INSTANCE is not deployed on this server"
[ -f "$ARCHIVE" ] || die "no archive at $ARCHIVE"

[ -n "$HEALTH_PATH" ] || HEALTH_PATH=$(state_get "$INSTANCE" healthCheckPath 2>/dev/null || echo /)

PORTS=$(allocate_ports "$INSTANCE")
WEB_PORT=$(printf '%s' "$PORTS" | jq -r .web)
PB_PORT=$(printf '%s' "$PORTS" | jq -r .pb)

# Two restores at once would each move the other's pb_data aside.
exec 9>"$APP/.restore.lock"
flock -n 9 || die "another restore is already running for $INSTANCE"

# ---------------------------------------------------------------- preflight
#
# Everything that can be checked before a service stops is checked before a
# service stops. A restore that fails here has changed nothing at all.

log "checking the archive"
unzip -tq "$ARCHIVE" >/dev/null 2>&1 || die "$ARCHIVE is not a readable zip archive"

# Restoring from a key means reading a file out of pb_data/backups - the very
# directory about to be moved aside. Copy it clear first, or the unpack below
# would be reading from a path that no longer exists.
case "$ARCHIVE" in
	"$PB_DATA"/*)
		mkdir -p "$APP/shared/.restore"
		cp -a "$ARCHIVE" "$APP/shared/.restore/"
		ARCHIVE="$APP/shared/.restore/$(basename "$ARCHIVE")"
		CLEANUP_ARCHIVE=1
		;;
esac
unzip -l "$ARCHIVE" 2>/dev/null | grep -qE '[[:space:]]data\.db$' \
	|| die "$ARCHIVE has no data.db - it is not a PocketBase backup"

# The credentials have to exist before anything moves: without them the restored
# database cannot be reconciled, and the app would 401 on every render.
SU_EMAIL=$(env_file_get "$ETC/env" POCKETBASE_SUPERUSER_EMAIL || true)
SU_PASSWORD=$(env_file_get "$ETC/env" POCKETBASE_SUPERUSER_PASSWORD || true)
[ -n "$SU_EMAIL" ] && [ -n "$SU_PASSWORD" ] \
	|| die "$INSTANCE has no superuser credentials in its environment - deploy it first"

# The archive unpacks beside the directory it replaces, and the old copy is kept
# rather than deleted, so its space is never reclaimed. What has to be free is
# therefore the whole unpacked archive - plus the uploads again, if they have to
# be carried across because the archive was taken while S3 was on.
ARCHIVE_KB=$(unzip -Zt "$ARCHIVE" | awk 'NR == 1 {print int($3 / 1024) + 1}')
NEEDED_KB=$((ARCHIVE_KB + ARCHIVE_KB / 10))
if ! unzip -l "$ARCHIVE" 2>/dev/null | grep -qE '[[:space:]]storage/'; then
	NEEDED_KB=$((NEEDED_KB + $(du -sk "$PB_DATA/storage" 2>/dev/null | cut -f1 || echo 0)))
fi
AVAILABLE_KB=$(df -Pk "$APP" | awk 'NR == 2 {print $4}')
if [ "$AVAILABLE_KB" -lt "$NEEDED_KB" ]; then
	die "not enough disk space: the restore needs $((NEEDED_KB / 1024))M and $((AVAILABLE_KB / 1024))M is free"
fi

# ---------------------------------------------------------------- transaction

SWAPPED=0
RESTORED=0
STAGE="$APP/shared/.restore-stage.$$"

revert() {
	log "restore failed - putting the previous database back"
	if [ "$SWAPPED" = "1" ]; then
		# Never deleted: a half-restored database is still evidence.
		if [ -d "$PB_DATA" ]; then mv -Tf "$PB_DATA" "$APP/shared/pb_data.failed-$STAMP" || true; fi
		# on_exit carries the original failure out; saying `die` here would only
		# replace one non-zero code with another and re-enter this path.
		mv -Tf "$PREVIOUS_DIR" "$PB_DATA" \
			|| log "could not put $PREVIOUS_DIR back at $PB_DATA - this instance needs a hand"
	fi
	rm -rf "$STAGE"
	systemctl start "$PB_UNIT" >/dev/null 2>&1 || true
	systemctl start "$WEB_UNIT" >/dev/null 2>&1 || true
}

on_exit() {
	local code=$?
	if [ "$RESTORED" = "0" ]; then revert; fi
	exit "$code"
}
trap on_exit EXIT

log "stopping services"
systemctl stop "$WEB_UNIT" >/dev/null 2>&1 || true
systemctl stop "$PB_UNIT" >/dev/null 2>&1 || true

# Unpacked next to pb_data so that the swap below is a rename on one filesystem
# rather than a copy of everything the archive holds.
log "unpacking $(basename "$ARCHIVE")"
rm -rf "$STAGE"
mkdir -p "$STAGE"
unzip -q "$ARCHIVE" -d "$STAGE" || die "could not unpack $ARCHIVE"
[ -f "$STAGE/data.db" ] || die "$ARCHIVE unpacked without a data.db"

# The extraction ran as root. This -R is over a fresh tree of known size, which
# is the case the recursive form is actually for.
chown -R "$VELA_USER:$VELA_USER" "$STAGE"

# An archive taken while uploads were in S3 has no storage/ at all. Copied, not
# moved, so the directory set aside below stays a complete rollback.
if [ ! -d "$STAGE/storage" ] && [ -d "$PB_DATA/storage" ]; then
	log "the archive has no uploads - keeping the ones already on disk"
	cp -a "$PB_DATA/storage" "$STAGE/storage"
	CARRIED_STORAGE=1
else
	CARRIED_STORAGE=0
fi

# An archive taken from a later release than the one running carries a schema
# this code has not seen. `migrate up` cannot help - the archive is ahead, not
# behind - and `migrate down` is not an option either, because the migrations
# that would reverse it live in a release that may already have been pruned. Say
# so rather than restoring into a mismatch silently.
if [ -d "$APP/current/migrations" ]; then
	# `|| true` because this is advisory: an archive old enough to predate the
	# _migrations table would otherwise fail the pipeline and abort the restore.
	AHEAD=$(sqlite3 "$STAGE/data.db" 'select file from _migrations' 2>/dev/null \
		| while read -r file; do
			[ -n "$file" ] || continue
			[ -f "$APP/current/migrations/$file" ] || printf 'x'
		done | wc -c | tr -d ' ' || true)
	if [ "${AHEAD:-0}" -gt 0 ] 2>/dev/null; then
		log "warning: this backup is $AHEAD migration(s) ahead of the running release"
		log "warning: deploy the matching code, or expect the app to see columns it does not know"
	fi
fi

log "replacing the database"
mv -Tf "$PB_DATA" "$PREVIOUS_DIR"
SWAPPED=1
mv -Tf "$STAGE" "$PB_DATA"

if [ "$MIGRATE" = "1" ] && [ -d "$APP/current/migrations" ]; then
	log "running migrations"
	runuser -u "$VELA_USER" -- "$APP/bin/pocketbase" \
		--dir "$PB_DATA" \
		--migrationsDir "$APP/current/migrations" \
		migrate up >&2 \
		|| die "migrations failed against the restored database"
fi

# Unconditional, and after the migrations so that _superusers matches the schema
# the running release expects. --force because the env file did not change: the
# fingerprint cannot see that the database underneath it did.
reconcile_superuser "$APP" "$ETC" "$SU_EMAIL" "$SU_PASSWORD" --force

log "starting PocketBase on 127.0.0.1:$PB_PORT"
systemctl start "$PB_UNIT"
wait_for_http "http://127.0.0.1:$PB_PORT/api/health" 60 0.5 \
	|| die "PocketBase did not become healthy - journalctl -u $PB_UNIT"

# wait_for_http accepts 4xx, so the health check above passes even when the app
# would 401 on every render. Only an actual login proves the restore is usable.
assert_superuser_auth "$PB_PORT" "$SU_EMAIL" "$SU_PASSWORD" \
	|| die "the restored database does not accept this instance's superuser credentials"

log "starting app on 127.0.0.1:$WEB_PORT"
systemctl start "$WEB_UNIT"
wait_for_http "http://127.0.0.1:$WEB_PORT$HEALTH_PATH" 60 0.5 \
	|| die "app did not become healthy at $HEALTH_PATH - journalctl -u $WEB_UNIT"

RESTORED=1

# ------------------------------------------------------- the backup history
#
# PocketBase leaves backups/ out of the archives it writes, so the restored
# pb_data has none and every other snapshot on the box would otherwise be
# stranded in the directory set aside above. Moved only now that the restore has
# been proven: until this point any failure still has to be able to put the old
# directory back exactly as it was.

if [ -d "$PREVIOUS_DIR/backups" ]; then
	log "carrying the backup history forward"
	mkdir -p "$PB_DATA/backups"
	find "$PREVIOUS_DIR/backups" -maxdepth 1 -type f -exec mv -t "$PB_DATA/backups" {} +
	chown -R "$VELA_USER:$VELA_USER" "$PB_DATA/backups"
fi

# --------------------------------------------------------------------- state

state_merge "$INSTANCE" "$(jq -c -n \
	--arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
	--arg from "$(basename "$ARCHIVE")" \
	--arg previous "$PREVIOUS_DIR" \
	'{restoredAt: $at, restoredFrom: $from, previousDataDir: $previous}')"

# ------------------------------------------------------------------- cleanup

if [ "$CLEANUP_ARCHIVE" = "1" ]; then
	rm -f "$ARCHIVE"
	rmdir "$APP/shared/.restore" 2>/dev/null || true
fi

if [ "$KEEP_PREVIOUS" -gt 0 ] 2>/dev/null; then
	mapfile -t old < <(ls -1d "$APP"/shared/pb_data.pre-restore-* 2>/dev/null | sort -r | tail -n +$((KEEP_PREVIOUS + 1)))
	for dir in "${old[@]:-}"; do
		[ -n "$dir" ] || continue
		log "removing $(basename "$dir")"
		rm -rf "$dir"
	done
fi

emit_result \
	--arg instance "$INSTANCE" --arg archive "$(basename "$ARCHIVE")" \
	--arg previous "$PREVIOUS_DIR" --argjson migrated "$MIGRATE" \
	--argjson storage "$CARRIED_STORAGE" \
	'{instance: $instance, archive: $archive, previousDataDir: $previous,
	  migrated: ($migrated == 1), storageCarriedOver: ($storage == 1)}'
