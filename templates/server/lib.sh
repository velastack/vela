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
# scope_dir <app-id> <all|preview> - an env layer shared by several instances.
# Its own tree because the production instance is named after the app id, so
# /etc/vela/apps/<app-id> is production's directory, not the app's.
scope_dir() { printf '%s/scopes/%s/%s' "$VELA_ETC" "$1" "$2"; }
# link_scope <app-id> <all|preview> <etc-dir> - point an instance's fixed-name
# scope.<layer>.env and scope.<layer>.public.env at that layer's files.
# `-n` replaces an existing link rather than following it; the targets are files,
# so there is never a directory for a plain `ln -sf` to descend into.
link_scope() {
	local dir; dir=$(scope_dir "$1" "$2")
	ln -sfn "$dir/env" "$3/scope.$2.env"
	ln -sfn "$dir/env.public" "$3/scope.$2.public.env"
}
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

# When an instance was last removed, so a deploy that was already under way
# cannot bring it back.
#
# A deploy spends minutes building on its own machine before it reaches the
# server and takes the instance lock; a destroy that lands in that window finds
# nothing to remove, and the deploy then creates the instance that was meant
# to be gone. CI does this whenever a pull request closes while a push to it
# is still building: the cleanup runs first and the preview appears after it.
#
# destroy.sh records the server's clock here, whether or not there was anything
# to remove. A release id starts with the server's clock at the moment its
# deploy began, so apply.sh can tell a deploy that started before the removal
# (refused) from one that started after it (a fresh deploy - the pull request
# was reopened, say - which goes ahead and clears the mark). Kept under state/,
# not the instance's own directory, which a purge deletes.

# Exit status of that refusal, so the CLI can tell it apart from a failed deploy.
# shellcheck disable=SC2034 # read by apply.sh
REMOVED_EXIT=3
removed_file() { printf '%s/state/removed/%s' "$VELA_ROOT" "$1"; }

# usage: mark_removed <instance>
mark_removed() {
	local file
	file=$(removed_file "$1")
	mkdir -p "$(dirname "$file")"
	# A mark only matters to a deploy that began before it, and no build takes a
	# month; pruning keeps one file per pull request from piling up forever.
	find "$(dirname "$file")" -maxdepth 1 -type f -mtime +30 -delete 2>/dev/null || true
	date -u +%Y%m%dT%H%M%SZ > "$file"
}

# The stamp of the instance's last removal, or nothing.
removed_at() {
	local file
	file=$(removed_file "$1")
	if [ -f "$file" ]; then head -n1 "$file"; fi
}

# Whether `release` belongs to a deploy that began no later than the instance's
# last removal. A tie counts as before: a deploy and a destroy in the same
# second are far more likely to be the race than a deliberate redeploy.
#
# usage: removed_since_release <instance> <release>
removed_since_release() {
	local removed
	removed=$(removed_at "$1")
	[ -n "$removed" ] && ! [[ "${2%%-*}" > "$removed" ]]
}

clear_removed() { rm -f "$(removed_file "$1")"; }

# Whether an instance was last deployed with a PocketBase backend: `true` or
# `false`. Absent state, or state from before the flag existed, is treated as
# having one, so this only ever answers `false` for an instance that was
# deployed with --backend 0.
instance_backend() {
	local instance=$1 value
	value=$(state_get "$instance" backend 2>/dev/null || echo true)
	[ "$value" = "false" ] && printf 'false' || printf 'true'
}

# Refuse on a frontend-only instance.
require_backend() {
	local instance=$1
	[ "$(instance_backend "$instance")" = "true" ] \
		|| die "$instance has no database - there is nothing to back up or restore"
}

# Read a top-level key out of an instance's state file.
state_get() {
	local instance=$1 key=$2 file
	file=$(state_file "$instance")
	[ -f "$file" ] || return 1
	# Presence is checked on its own: `// empty` would swallow a legitimate
	# `false`, and so would `-e` on the read, which exits non-zero for one.
	jq -e --arg k "$key" 'has($k) and .[$k] != null' "$file" >/dev/null 2>&1 || return 1
	jq -r --arg k "$key" '.[$k]' "$file" 2>/dev/null
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
#
# A fourth argument is the public host to ask as, the way Caddy would. An app
# serving several hosts has no pinned origin and tells its sites apart by
# `Host`; asked as 127.0.0.1 it may rightly answer that it serves no such site.
#
# X-Forwarded-For always, as Caddy would send it: the app reads the client
# address from it (ADDRESS_HEADER), and adapter-node throws from
# `getClientAddress()` on a request without one.
wait_for_http() {
	local url=$1 attempts=${2:-60} delay=${3:-0.5} host=${4:-} code
	local i=0
	local -a as=(-H 'X-Forwarded-For: 127.0.0.1')
	[ -z "$host" ] || as+=(-H "Host: $host" -H 'X-Forwarded-Proto: https')
	while [ "$i" -lt "$attempts" ]; do
		code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "${as[@]}" "$url" 2>/dev/null || echo 000)
		case "$code" in
			2*|3*|401|403) return 0 ;;
		esac
		i=$((i + 1))
		sleep "$delay"
	done
	return 1
}

# The public host an instance's health check should ask as: the host of the
# `url` its last deploy recorded, or nothing for an instance no domain points
# at (whose url is its own loopback address).
#
# usage: state_primary_host <instance>
state_primary_host() {
	local url
	url=$(state_get "$1" url 2>/dev/null) || return 0
	case "$url" in
		https://*) url=${url#https://}; printf '%s' "${url%%/*}" ;;
	esac
}

# The lines of runtime.env that tell adapter-node what origin a request has.
#
# SvelteKit 3's adapter-node has no ORIGIN variable. A release built for one
# host has that host baked in as `paths.origin` (the CLI passes it to the build
# as VELA_ORIGIN), so nothing a client sends can change what the app believes
# its own address is. A release built for several hosts has none - one origin
# would make the second host render as the first and have its form posts
# refused as cross-site - so each request brings its own: `Host`, which Caddy
# passes through and only ever for the names in this instance's site block,
# and the scheme from the X-Forwarded-Proto Caddy sets itself. That is what
# PROTOCOL_HEADER names, and it is emitted either way: it is only consulted
# when no origin was baked in.
#
# ORIGIN stays for a single host, where it is inert under SvelteKit 3 (the
# adapter only rejects unknown variables when given an envPrefix, and vela
# sets none) but is what a SvelteKit 2 release pins itself with: `vela
# rollback` to one rewrites only VELA_RELEASE, so this line has to be here
# already. A SvelteKit 2 release given ORIGIN ignores PROTOCOL_HEADER.
#
# Managed velastack.app names do not count: beside a direct host they redirect
# at the edge rather than being served. The CLI counts the same way when it
# decides whether to bake an origin in (`buildOrigin`).
#
# usage: runtime_origin_lines <direct_hosts_csv> <primary_url>
runtime_origin_lines() {
	local direct=$1 primary_url=$2 count
	count=$(printf '%s' "$direct" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | grep -c -v '^$' || true)
	printf 'PROTOCOL_HEADER=x-forwarded-proto\n'
	if [ "$count" -le 1 ]; then
		printf 'ORIGIN=%s\n' "$primary_url"
	fi
}

# Whether the server's Node is at least <major>.<minor>. A vela project needs
# 22.22, which a server provisioned earlier may not have; `vela provision` upgrades it. No Node at all, or a version that
# cannot be read, is not enough.
#
# usage: node_at_least <major> <minor>
node_at_least() {
	local want_major=$1 want_minor=$2 version major minor
	command -v node >/dev/null 2>&1 || return 1
	version=$(node -v 2>/dev/null) || return 1
	version=${version#v}
	major=${version%%.*}
	minor=${version#*.}
	minor=${minor%%.*}
	[[ $major =~ ^[0-9]+$ && $minor =~ ^[0-9]+$ ]] || return 1
	[ "$major" -gt "$want_major" ] && return 0
	[ "$major" -eq "$want_major" ] && [ "$minor" -ge "$want_minor" ]
}

# Whether a release's package.json asks for nothing at runtime: it parses, and
# has no `dependencies`, `optionalDependencies` or `peerDependencies` (npm
# installs a project's peers too) and no `workspaces`. An empty object counts
# as none. A file that cannot be read answers no, so the install runs and
# reports the problem itself.
#
# A scaffolded vela app is like this: its build is bundled and everything it
# needs to produce one is a devDependency, which the server never installs.
#
# usage: package_without_runtime_deps <package.json>
package_without_runtime_deps() {
	node -e '
		const pkg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
		const some = (value) =>
			value != null && typeof value === "object" && Object.keys(value).length > 0;
		const wanted =
			some(pkg.dependencies) || some(pkg.optionalDependencies) ||
			some(pkg.peerDependencies) || pkg.workspaces != null;
		process.exit(wanted ? 1 : 0);
	' "$1" 2>/dev/null
}

# Rewrite the copy of package.json that the server installs from.
#
# `prepare` always goes: it is a development hook (`svelte-kit sync`, husky)
# whose tools are devDependencies, which are not installed here, so it can only
# print "svelte-kit: not found". Dependencies' own install scripts still run.
#
# `devDependencies` go when asked, which is when there is no package-lock.json
# to replay: `npm install --omit=dev` resolves the whole development tree
# before leaving it out, and on a small server that is what runs it out of
# memory. With a lockfile the file has to stay as the lockfile describes it.
#
# usage: prepare_install_manifest <package.json> <drop-dev: 0|1>
prepare_install_manifest() {
	node -e '
		const fs = require("fs");
		const [file, dropDev] = process.argv.slice(1);
		const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
		let changed = false;
		if (pkg.scripts && pkg.scripts.prepare) {
			delete pkg.scripts.prepare;
			changed = true;
		}
		if (dropDev === "1" && pkg.devDependencies) {
			delete pkg.devDependencies;
			changed = true;
		}
		if (changed) fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
	' "$1" "${2:-0}"
}

# One field of /proc/meminfo in whole megabytes, or `?` when it cannot be read.
#
# usage: meminfo_mb <field> [meminfo-file]
meminfo_mb() {
	local kb
	kb=$(awk -v field="$1:" '$1 == field { print $2; exit }' "${2:-/proc/meminfo}" 2>/dev/null)
	if [[ $kb =~ ^[0-9]+$ ]]; then printf '%s' $((kb / 1024)); else printf '?'; fi
}

# What to say when the dependency install exits non-zero. 137 is 128 + SIGKILL,
# and on a server nobody is logged in to, the sender is the kernel's
# out-of-memory killer; the shell's own report of that is the single word
# "Killed".
#
# usage: install_failure_message <exit-status> [meminfo-file]
install_failure_message() {
	local status=$1 meminfo=${2:-/proc/meminfo}
	if [ "$status" != 137 ]; then
		printf 'dependency install failed (exit %s)' "$status"
		return 0
	fi
	printf '%s' \
		"dependency install failed: npm was killed (exit 137), most likely by the kernel's out-of-memory killer." \
		" This server has $(meminfo_mb MemTotal "$meminfo") MB of memory and $(meminfo_mb SwapTotal "$meminfo") MB of swap." \
		" Add swap ('vela provision' now creates a swapfile on small servers) or move to a larger server, then deploy again."
}

# Whether `vela provision` should add a swapfile, and how big.
#
# A server with less than 2 GB of memory and no swap has no slack at all: one
# `npm install` or one build of a native module beside the running apps is
# enough for the kernel to start killing processes, and it does not pick only
# the newcomer. Swap that is already there, of any size and kind, is somebody's
# decision and is left alone. The file must not be what fills the disk either.
#
# Prints one of:
#   none  enough memory, or swap is already active
#   disk  wanted, but under 4 GB is free where the file would go
#   1024  megabytes to create (under 8 GB free)
#   2048  megabytes to create
#
# usage: swap_plan <mem-total-kb> <swap-total-kb> <free-disk-kb>
swap_plan() {
	local mem=$1 swap=$2 free=$3
	if ! [[ $mem =~ ^[0-9]+$ && $swap =~ ^[0-9]+$ && $free =~ ^[0-9]+$ ]]; then
		printf 'none'
	elif [ "$mem" -ge $((2 * 1024 * 1024)) ] || [ "$swap" -gt 0 ]; then
		printf 'none'
	elif [ "$free" -lt $((4 * 1024 * 1024)) ]; then
		printf 'disk'
	elif [ "$free" -lt $((8 * 1024 * 1024)) ]; then
		printf '1024'
	else
		printf '2048'
	fi
}

# Have a swapfile turned on at boot, adding its line to fstab once.
#
# usage: fstab_add_swap <swapfile> [fstab]
fstab_add_swap() {
	local file=$1 fstab=${2:-/etc/fstab}
	if [ -f "$fstab" ] && awk -v file="$file" '$1 == file { found = 1 } END { exit !found }' "$fstab"; then
		return 0
	fi
	# A last line without its newline would otherwise swallow this one.
	if [ -s "$fstab" ] && [ -n "$(tail -c1 "$fstab")" ]; then printf '\n' >> "$fstab"; fi
	printf '%s none swap sw 0 0\n' "$file" >> "$fstab"
}

# Whether a release has anything installed in its node_modules. An app with no
# runtime dependencies gets an empty one (see install_deps in apply.sh), and
# such an app has nothing compiled for a particular Node: it does not need a
# redeploy when `vela provision` moves the server to a new major. npm's own
# bookkeeping (`.package-lock.json`) does not count.
#
# usage: release_has_modules <release-dir>
release_has_modules() {
	[ -n "$(find "$1/node_modules/" -mindepth 1 -maxdepth 1 ! -name '.*' -print -quit 2>/dev/null)" ]
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

# Point an instance's runtime.env at a release. Rewritten whole and renamed
# into place, the way apply.sh writes it, so systemd never reads half a line.
#
# usage: set_runtime_release <etc_dir> <release>
set_runtime_release() {
	local etc=$1 release=$2 tmp
	[ -f "$etc/runtime.env" ] || return 0
	tmp=$(mktemp "$etc/.runtime.XXXXXX")
	sed "s|^VELA_RELEASE=.*|VELA_RELEASE=$release|" "$etc/runtime.env" > "$tmp"
	chmod 0600 "$tmp"
	chown root:root "$tmp" 2>/dev/null || true
	mv -f "$tmp" "$etc/runtime.env"
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

# Whether the server's Caddy is at least <major>.<minor>. `caddy version` prints
# `v2.11.7 h1:...` from Caddy's own packages and a bare `2.6.2` from Ubuntu's.
#
# usage: caddy_at_least <major> <minor>
caddy_at_least() {
	local want_major=$1 want_minor=$2 version major minor
	command -v caddy >/dev/null 2>&1 || return 1
	version=$(caddy version 2>/dev/null | head -n1 | awk '{print $1}') || return 1
	version=${version#v}
	major=${version%%.*}
	minor=${version#*.}
	minor=${minor%%.*}
	[[ $major =~ ^[0-9]+$ && $minor =~ ^[0-9]+$ ]] || return 1
	[ "$major" -gt "$want_major" ] && return 0
	[ "$major" -eq "$want_major" ] && [ "$minor" -ge "$want_minor" ]
}

# The Caddy that holds every request through a restart. Measured with a
# request held against a port nothing listened on for four seconds: Ubuntu
# 24.04's package (2.6.2) answered a GET once the port opened but a POST with
# a body got a 502; 2.11.7 answered both. Nothing in between was tried, so the
# floor is the version that was seen to work. `vela provision` moves an older
# one to Caddy's current package.
# shellcheck disable=SC2034 # read by apply.sh and provision.sh
CADDY_HOLD_MAJOR=2
# shellcheck disable=SC2034
CADDY_HOLD_MINOR=11

# The `reverse_proxy` options that turn a restart into a pause.
#
# A deploy, rollback or restore stops the app before it touches the database
# and starts it last, so for those seconds nothing listens on the app's port.
# Without these Caddy answers each request in that window with a 502. With
# them a refused connection is tried again every quarter second for up to
# VELA_PROXY_HOLD, and the request is answered by whichever release comes up:
# a visitor sees one slow page instead of an error. Only a connection that was
# never made is retried, so nothing is ever sent to the app twice.
#
# The hold has to outlast the stopped window: the app's drain (SHUTDOWN_TIMEOUT
# in vela-web@.service), migrations, and both services starting. It also
# applies when the app is simply down, where it delays the 502 by as long.
#
# usage: caddy_proxy_hold <indent>
VELA_PROXY_HOLD=${VELA_PROXY_HOLD:-30s}
caddy_proxy_hold() {
	printf '%slb_try_duration %s\n' "$1" "$VELA_PROXY_HOLD"
	printf '%slb_try_interval 250ms\n' "$1"
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
