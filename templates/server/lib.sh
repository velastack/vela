#!/usr/bin/env bash
# Shared helpers for the vela server scripts. Sourced, never run directly.

VELA_ROOT=${VELA_ROOT:-/var/lib/vela}
VELA_ETC=${VELA_ETC:-/etc/vela}
VELA_USER=${VELA_USER:-vela}
VELA_WEB_PORT_BASE=${VELA_WEB_PORT_BASE:-4100}
VELA_PB_PORT_BASE=${VELA_PB_PORT_BASE:-8100}
VELA_PORT_RANGE=${VELA_PORT_RANGE:-900}

app_dir() { printf '%s/apps/%s' "$VELA_ROOT" "$1"; }
etc_dir() { printf '%s/apps/%s' "$VELA_ETC" "$1"; }
state_file() { printf '%s/apps/%s/state.json' "$VELA_ROOT" "$1"; }

log() { printf '  %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Release ids are compared as strings, in `sort` and in `[[ < ]]` alike, and
# the two have to agree whatever locale the server booted with.
export LC_ALL=C

# An instance id is `<appId>` or `<appId>--<envTag>`: lowercase letters and
# digits joined by single or double dashes, exactly what the CLI's instanceId()
# produces. It arrives from the CLI, but it ends up in paths that root removes,
# so its shape is checked here too before anything is touched.
require_instance_id() {
	[[ $1 =~ ^[a-z0-9]+(-{1,2}[a-z0-9]+)*$ ]] || die "not an instance id: $1"
}

# A release id is a UTC stamp with an optional short suffix: 20260910T141203Z
# or 20260910T141203Z-a3f9.
require_release_id() {
	[[ $1 =~ ^[0-9]{8}T[0-9]{6}Z(-[a-z0-9]{1,8})?$ ]] || die "not a release id: $1"
}

# Hold the instance's lock for the rest of this process.
#
# Every script that mutates an instance - deploy, destroy, rollback, restore -
# takes this first, so two of them can never interleave: the second waits for
# the first, up to `wait` seconds, then gives up. The lock file lives under
# state/ rather than in the instance's own directory, so a purge cannot unlink
# a lock somebody else is holding. Descriptor 8; 9 belongs to the port table.
#
# usage: lock_instance <instance> [wait_seconds]
lock_instance() {
	local instance=$1 wait=${2:-300} dir="$VELA_ROOT/state/locks"
	mkdir -p "$dir"
	exec 8>"$dir/$instance.lock"
	if flock -n 8; then return 0; fi
	[ "$wait" -gt 0 ] 2>/dev/null \
		|| die "another deploy, destroy, rollback or restore is running for $instance - aborting"
	log "waiting for another operation on $instance to finish (up to ${wait}s)"
	flock -w "$wait" 8 \
		|| die "another deploy, destroy, rollback or restore is still running for $instance after ${wait}s - aborting"
}

require_provisioned() {
	[ -f "$VELA_ETC/provisioned" ] || die "server is not provisioned - run 'vela provision' first"
}

# Refuse on a frontend-only instance. Absent state is treated as having one, so
# this only ever fires on an instance that was deployed with --backend 0.
require_backend() {
	local instance=$1
	[ "$(state_get "$instance" backend 2>/dev/null || echo true)" = "true" ] \
		|| die "$instance has no database - there is nothing to back up or restore"
}

# Read a top-level key out of an instance's state file.
state_get() {
	local instance=$1 key=$2 file
	file=$(state_file "$instance")
	[ -f "$file" ] || return 1
	# `// empty` would swallow a legitimate `false`, so test for the key itself.
	jq -er --arg k "$key" 'if has($k) and .[$k] != null then .[$k] else empty end' "$file" 2>/dev/null
}

# Merge a JSON object into an instance's state file, atomically.
state_merge() {
	local instance=$1 patch=$2 file tmp
	file=$(state_file "$instance")
	mkdir -p "$(dirname "$file")"
	[ -f "$file" ] || echo '{}' > "$file"
	tmp=$(mktemp "$(dirname "$file")/.state.XXXXXX")
	jq -S --argjson patch "$patch" '. * $patch' "$file" > "$tmp"
	chown "$VELA_USER:$VELA_USER" "$tmp" 2>/dev/null || true
	mv -f "$tmp" "$file"
}

# Assign a web/PocketBase port pair to an instance, or echo the existing one.
# Ports live in one server-wide file guarded by flock so that concurrent
# deploys of different apps cannot land on the same port.
allocate_ports() {
	local instance=$1
	local ports_file="$VELA_ROOT/state/ports.json"
	local lock="$VELA_ROOT/state/.ports.lock"
	mkdir -p "$VELA_ROOT/state"
	[ -f "$ports_file" ] || echo '{}' > "$ports_file"
	touch "$lock"

	(
		flock 9
		local existing
		existing=$(jq -er --arg i "$instance" '.[$i] // empty' "$ports_file")
		if [ -n "$existing" ]; then
			printf '%s' "$existing"
			exit 0
		fi

		local offset=0 web pb
		while [ "$offset" -lt "$VELA_PORT_RANGE" ]; do
			web=$((VELA_WEB_PORT_BASE + offset))
			pb=$((VELA_PB_PORT_BASE + offset))
			if ! jq -e --argjson w "$web" 'to_entries | any(.value.web == $w)' "$ports_file" >/dev/null \
				&& ! port_in_use "$web" && ! port_in_use "$pb"; then
				local tmp
				tmp=$(mktemp "$VELA_ROOT/state/.ports.XXXXXX")
				jq -S --arg i "$instance" --argjson w "$web" --argjson p "$pb" \
					'.[$i] = {web: $w, pb: $p}' "$ports_file" > "$tmp"
				mv -f "$tmp" "$ports_file"
				jq -c -n --argjson w "$web" --argjson p "$pb" '{web: $w, pb: $p}'
				exit 0
			fi
			offset=$((offset + 1))
		done
		die "no free port pair in range"
	) 9>"$lock"
}

release_ports() {
	local instance=$1
	local ports_file="$VELA_ROOT/state/ports.json"
	local lock="$VELA_ROOT/state/.ports.lock"
	[ -f "$ports_file" ] || return 0
	(
		flock 9
		local tmp
		tmp=$(mktemp "$VELA_ROOT/state/.ports.XXXXXX")
		jq -S --arg i "$instance" 'del(.[$i])' "$ports_file" > "$tmp"
		mv -f "$tmp" "$ports_file"
	) 9>"$lock"
}

port_in_use() {
	local port=$1
	if command -v ss >/dev/null 2>&1; then
		ss -ltn "sport = :$port" 2>/dev/null | tail -n +2 | grep -q . && return 0
	fi
	return 1
}

unit_web() { printf 'vela-web@%s.service' "$1"; }
unit_pb() { printf 'vela-pb@%s.service' "$1"; }

unit_active() { systemctl is-active --quiet "$1"; }

# Poll an HTTP endpoint until it answers like a running app.
#
# Success, a redirect, or a refusal that proves something is home (401, 403 -
# a health path behind auth). A 404 is not that: it is what a wrong
# --health-path or a route that never mounted looks like, and it used to pass.
# No `-f`: curl has to report the status of an error response, not fail on it.
wait_for_http() {
	local url=$1 attempts=${2:-60} delay=${3:-0.5} code
	local i=0
	while [ "$i" -lt "$attempts" ]; do
		code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || echo 000)
		case "$code" in
			2*|3*|401|403) return 0 ;;
		esac
		i=$((i + 1))
		sleep "$delay"
	done
	return 1
}

# How many migrations the current release has that the target release does not.
# PocketBase reverts by count, so this is what `migrate down` needs.
migrations_ahead() {
	local current_dir=$1 target_dir=$2 count=0 f
	[ -d "$current_dir" ] || { printf '0'; return 0; }
	for f in "$current_dir"/*.js; do
		[ -f "$f" ] || continue
		if [ ! -f "$target_dir/$(basename "$f")" ]; then count=$((count + 1)); fi
	done
	printf '%s' "$count"
}

# Revert the migrations `from_dir` has that `to_dir` lacks. They run from
# `from_dir` - the release that introduced them owns their down steps - and
# PocketBase reverts by count, which `migrations_ahead` supplies. The
# instance's PocketBase must be stopped: `migrate down` opens the database
# directly. Returns non-zero if PocketBase refuses; the caller decides how bad
# that is.
#
# usage: revert_migrations <app_dir> <from_dir> <to_dir>
revert_migrations() {
	local app=$1 from=$2 to=$3 ahead
	ahead=$(migrations_ahead "$from" "$to")
	[ "$ahead" -gt 0 ] || return 0
	log "reverting $ahead migration(s) the previous release does not have"
	runuser -u "$VELA_USER" -- "$app/bin/pocketbase" \
		--dir "$app/shared/pb_data" \
		--migrationsDir "$from" \
		migrate down "$ahead" >&2
}

emit_result() { printf 'VELA_RESULT %s\n' "$(jq -c -n "$@")"; }

# Read one value out of a vela-managed env file. `vela env` writes values with
# systemd's quoting, whose escapes (\\, \", \n, \t) are also JSON's, so jq
# decodes them exactly.
env_file_get() {
	local file=$1 key=$2 raw
	[ -f "$file" ] || return 1
	raw=$(sed -n "s/^[[:space:]]*${key}=//p" "$file" | head -n1)
	[ -n "$raw" ] || return 1
	case "$raw" in
		'"'*) printf '%s' "$raw" | jq -r . ;;
		*) printf '%s' "$raw" ;;
	esac
}

# Append a value in the same quoted form `vela env` uses, so it round-trips.
env_file_append() {
	local file=$1 key=$2 value=$3
	[ -f "$file" ] || : > "$file"
	if [ -s "$file" ] && [ -n "$(tail -c1 "$file")" ]; then printf '\n' >> "$file"; fi
	printf '%s=%s\n' "$key" "$(jq -rn --arg v "$value" '$v | @json')" >> "$file"
	chmod 0600 "$file"
	chown root:root "$file"
}

# 24 bytes of hex - no shell metacharacters, nothing to escape anywhere it goes.
random_secret() {
	head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# Make the instance's database agree with the credentials in its env file.
#
# The app authenticates to its own PocketBase as a superuser on every render, so
# the two have to match or every request answers 401. `$ETC/env` is the source of
# truth: this pushes whatever it holds into the database and records a
# fingerprint of it, which is what lets an ordinary deploy skip the upsert when
# nothing has moved. A caller that replaced the database underneath the env file
# passes --force, because the fingerprint alone cannot see that.
#
# usage: reconcile_superuser <app_dir> <etc_dir> <email> <password> [--force]
reconcile_superuser() {
	local app=$1 etc=$2 email=$3 password=$4 force=${5:-}
	local stamp="$etc/.superuser" fingerprint
	fingerprint=$(printf '%s\n%s' "$email" "$password" | sha256sum | cut -d' ' -f1)

	if [ "$force" != "--force" ] && [ "$(cat "$stamp" 2>/dev/null || true)" = "$fingerprint" ]; then
		return 0
	fi

	# The stamp is written only after a successful upsert, so its absence is what
	# distinguishes a first account from a changed one.
	if [ -f "$stamp" ]; then
		log "updating the PocketBase superuser"
	else
		log "creating the PocketBase superuser"
	fi

	# The password reaches PocketBase as an argument, which is why this runs only
	# on the deploys that need it rather than on every one.
	runuser -u "$VELA_USER" -- "$app/bin/pocketbase" \
		--dir "$app/shared/pb_data" \
		superuser upsert "$email" "$password" >&2 \
		|| die "could not write the PocketBase superuser"

	# Recorded only once the database holds the account, so a failure above
	# leaves nothing behind and the next deploy simply tries again.
	printf '%s\n' "$fingerprint" > "$stamp"
	chmod 0600 "$stamp"
	chown root:root "$stamp"
}

# Prove the app's own credentials actually sign in to its database.
#
# `wait_for_http` accepts a 401 as healthy, so a PocketBase whose database no
# longer matches `$ETC/env` sails through the health gate and then answers every
# render with a 401. Only an actual login catches that. The password travels
# through the environment rather than argv, so it never appears in `ps`.
assert_superuser_auth() {
	local port=$1 email=$2 password=$3
	VELA_SU_EMAIL=$email VELA_SU_PASSWORD=$password \
		jq -nc '{identity: env.VELA_SU_EMAIL, password: env.VELA_SU_PASSWORD}' \
		| curl -fsS -o /dev/null --max-time 10 \
			-X POST -H 'content-type: application/json' --data-binary @- \
			"http://127.0.0.1:$port/api/collections/_superusers/auth-with-password"
}

# ------------------------------------------------------------------- caddy

CADDYFILE=${CADDYFILE:-/etc/caddy/Caddyfile}

caddy_valid() {
	caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1
}

# Put a generated snippet in place only if the whole Caddy config still
# validates with it there. The file it replaces is kept and restored on
# failure, so a bad generation cannot take a working route down.
#
# usage: caddy_install <tmp> <dest> [mode] [owner]
caddy_install() {
	local tmp=$1 dest=$2 mode=${3:-0644} owner=${4:-root:root} backup=""
	chmod "$mode" "$tmp"
	chown "$owner" "$tmp"
	if [ -f "$dest" ]; then
		backup=$(mktemp "$(dirname "$dest")/.previous.XXXXXX")
		cp -p "$dest" "$backup"
	fi
	mv -f "$tmp" "$dest"
	if caddy_valid; then
		[ -z "$backup" ] || rm -f "$backup"
		return 0
	fi
	if [ -n "$backup" ]; then
		mv -f "$backup" "$dest"
	else
		rm -f "$dest"
	fi
	return 1
}

caddy_reload() {
	systemctl reload caddy >/dev/null 2>&1 || systemctl restart caddy
}

# Serialize every change to the Caddy config across instances.
#
# `caddy_valid` checks the whole Caddyfile, so two scripts installing snippets
# at once would each judge the other's: a bad snippet from one deploy would
# have the other roll back a good route of its own. Held from the first
# snippet write through the reload. Descriptor 7; blocking, since a Caddy
# change takes well under a second.
caddy_lock() {
	mkdir -p "$VELA_ROOT/state"
	exec 7>"$VELA_ROOT/state/.caddy.lock"
	flock 7
}

caddy_unlock() {
	exec 7>&-
}
