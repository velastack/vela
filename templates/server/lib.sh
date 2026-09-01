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

# Poll an HTTP endpoint until it answers with a non-5xx status.
wait_for_http() {
	local url=$1 attempts=${2:-60} delay=${3:-0.5} code
	local i=0
	while [ "$i" -lt "$attempts" ]; do
		code=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || echo 000)
		case "$code" in
			2*|3*|4*) return 0 ;;
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
# `wait_for_http` accepts 4xx as healthy, so a PocketBase whose database no
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
