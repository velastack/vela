#!/usr/bin/env bash
#
# Exercise the helpers in templates/server/lib.sh in a scratch directory.
#
# The scripts themselves only run on a provisioned server as root, so what can
# be checked without one is checked here: instance and release id validation,
# the per-instance lock, release ordering, and the health gate's verdicts.
# Needs Linux for `flock` (macOS ships without it); those cases are skipped
# elsewhere so the rest still runs. `npm run test:scripts`.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT

export VELA_ROOT="$SCRATCH/root" VELA_ETC="$SCRATCH/etc"
mkdir -p "$VELA_ROOT" "$VELA_ETC"
# shellcheck source=../templates/server/lib.sh
. "$ROOT/templates/server/lib.sh"

pass=0
fail=0
ok() { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1${2:+: $2}"; fail=$((fail + 1)); }

# expect_ok <name> <command...> - the command must succeed in a subshell.
expect_ok() {
	local name=$1; shift
	if ("$@" >/dev/null 2>&1); then ok "$name"; else bad "$name" "expected success"; fi
}
# expect_die <name> <command...> - the command must fail in a subshell.
expect_die() {
	local name=$1; shift
	if ("$@" >/dev/null 2>&1); then bad "$name" "expected failure"; else ok "$name"; fi
}

# ------------------------------------------------------------ id validation

for id in zdyly4bg3wuwr5x zdyly4bg3wuwr5x--staging velabase-e7a7079c \
	abc123--preview--feature-auth abc123--preview--fix-login-form-12-1a2b3c; do
	expect_ok "instance id accepts $id" require_instance_id "$id"
done
for id in '../x' 'A' 'a//b' '-a' 'a-' 'a--' '' 'a b' 'zdyly4bg3wuwr5x/../etc'; do
	expect_die "instance id rejects '$id'" require_instance_id "$id"
done

for id in 20260910T141203Z 20260910T141203Z-a3f9 20260910T141203Z-1; do
	expect_ok "release id accepts $id" require_release_id "$id"
done
for id in '20260910T141203' '20260910t141203z' '20260910T141203Z-' '20260910T141203Z-ABCD' \
	'../20260910T141203Z' '20260910T141203Z-toolongsuffix'; do
	expect_die "release id rejects '$id'" require_release_id "$id"
done

# ---------------------------------------------------------- release order
#
# apply.sh refuses a release that sorts at or below the active one. Ids with
# the new suffix must sort after a bare id of the same second, so the first
# deploy from a new CLI onto an old release still goes through.

order_ok() { [[ "$1" < "$2" ]]; }
expect_ok "later second sorts later" order_ok 20260910T120000Z-ffff 20260910T120001Z-0000
expect_ok "bare id sorts before suffixed id of the same second" order_ok 20260910T120000Z 20260910T120000Z-0000
expect_die "same id is not later" order_ok 20260910T120000Z-aaaa 20260910T120000Z-aaaa
expect_die "earlier second is not later" order_ok 20260910T120001Z-0000 20260910T120000Z-ffff

# ---------------------------------------------------------- env layers
#
# The shared layers live beside, not under, the app directories: production's
# instance is named after the app id, so apps/<id> is production's. An
# instance reaches them through fixed-name symlinks the units list.

scope_app=zdyly4bg3wuwr5x
[ "$(scope_dir "$scope_app" all)" = "$VELA_ETC/scopes/$scope_app/all" ] \
	&& ok "scope_dir: app-wide layer under scopes/<app>/all" || bad "scope_dir: app-wide layer"
[ "$(scope_dir "$scope_app" preview)" = "$VELA_ETC/scopes/$scope_app/preview" ] \
	&& ok "scope_dir: preview layer under scopes/<app>/preview" || bad "scope_dir: preview layer"

scope_etc="$VELA_ETC/apps/$scope_app--preview--x"; mkdir -p "$scope_etc"
link_scope "$scope_app" all "$scope_etc"
link_scope "$scope_app" preview "$scope_etc"
[ "$(readlink "$scope_etc/scope.all.env")" = "$VELA_ETC/scopes/$scope_app/all/env" ] \
	&& ok "link_scope: scope.all.env points at the layer's secret file" || bad "link_scope: scope.all.env" "$(readlink "$scope_etc/scope.all.env")"
[ "$(readlink "$scope_etc/scope.all.public.env")" = "$VELA_ETC/scopes/$scope_app/all/env.public" ] \
	&& ok "link_scope: scope.all.public.env points at the layer's public file" || bad "link_scope: scope.all.public.env"
[ "$(readlink "$scope_etc/scope.preview.env")" = "$VELA_ETC/scopes/$scope_app/preview/env" ] \
	&& ok "link_scope: scope.preview.env" || bad "link_scope: scope.preview.env"
[ ! -e "$scope_etc/.scope.tmp" ] && ok "link_scope: leaves no temp link behind" || bad "link_scope: temp link left"
# Linking twice replaces rather than nests (ln -s into an existing symlink to a
# directory would otherwise create a link inside the target).
link_scope "$scope_app" all "$scope_etc"
[ "$(readlink "$scope_etc/scope.all.env")" = "$VELA_ETC/scopes/$scope_app/all/env" ] \
	&& ok "link_scope: relinking is idempotent" || bad "link_scope: relinking"
mkdir -p "$VELA_ETC/scopes/$scope_app/all"
printf 'FROM_ALL="yes"\n' > "$VELA_ETC/scopes/$scope_app/all/env"
[ "$(cat "$scope_etc/scope.all.env")" = 'FROM_ALL="yes"' ] \
	&& ok "link_scope: a layer written later is read through the link" || bad "link_scope: read through"

# ---------------------------------------------------------- runtime.env

etc="$SCRATCH/etc/apps/x"; mkdir -p "$etc"
printf 'PORT=4101\nVELA_RELEASE=20260910T000000Z\nVELA_ENV=prod\n' > "$etc/runtime.env"
if (set_runtime_release "$etc" 20260910T120000Z-abcd >/dev/null 2>&1) \
	&& [ "$(cat "$etc/runtime.env")" = "$(printf 'PORT=4101\nVELA_RELEASE=20260910T120000Z-abcd\nVELA_ENV=prod')" ] \
	&& [ -z "$(ls -A "$etc" | grep -v '^runtime.env$')" ]; then
	ok "runtime.env: release rewritten, nothing else touched, no temp file left"
else
	bad "runtime.env: release rewritten, nothing else touched, no temp file left" "$(cat "$etc/runtime.env"; ls -A "$etc")"
fi
expect_ok "runtime.env: missing file is not an error" set_runtime_release "$SCRATCH/etc/apps/none" 20260910T120000Z

# ------------------------------------------------------------ request origin
#
# PROTOCOL_HEADER always, for a SvelteKit 3 release built with no origin. One
# served host also pins ORIGIN, which only a SvelteKit 2 release (a rollback)
# reads. Several direct hosts cannot share one, so the origin is taken from
# the request instead.

expect_lines() {
	local name=$1 want=$2; shift 2
	local got; got=$("$@" 2>&1)
	if [ "$got" = "$want" ]; then ok "$name"; else bad "$name" "got '$got'"; fi
}
expect_lines "origin: one direct host is pinned" \
	$'PROTOCOL_HEADER=x-forwarded-proto\nORIGIN=https://velastack.dev' \
	runtime_origin_lines 'velastack.dev' 'https://velastack.dev'
expect_lines "origin: no direct host pins the primary url" \
	$'PROTOCOL_HEADER=x-forwarded-proto\nORIGIN=https://app.velastack.app' \
	runtime_origin_lines '' 'https://app.velastack.app'
expect_lines "origin: no host at all pins loopback" \
	$'PROTOCOL_HEADER=x-forwarded-proto\nORIGIN=http://127.0.0.1:4101' \
	runtime_origin_lines '' 'http://127.0.0.1:4101'
expect_lines "origin: two direct hosts come from the request" \
	'PROTOCOL_HEADER=x-forwarded-proto' \
	runtime_origin_lines 'velastack.dev, velabase.dev' 'https://velastack.dev'
expect_lines "origin: a trailing comma is not a second host" \
	$'PROTOCOL_HEADER=x-forwarded-proto\nORIGIN=https://velastack.dev' \
	runtime_origin_lines 'velastack.dev, ' 'https://velastack.dev'

# ------------------------------------------------------------- node floor
#
# A stand-in `node` that reports whatever version the case needs, first on
# PATH, so node_at_least is checked through the same `node -v` it runs on a
# server.

fake_node_dir="$SCRATCH/fake-node"
mkdir -p "$fake_node_dir"
printf '#!/bin/sh\nprintf "%%s\\n" "$FAKE_NODE_VERSION"\n' > "$fake_node_dir/node"
chmod +x "$fake_node_dir/node"
with_node() {
	local version=$1; shift
	FAKE_NODE_VERSION=$version PATH="$fake_node_dir:$PATH" "$@"
}
expect_die "node floor: 22.16 is too old" with_node v22.16.0 node_at_least 22 17
expect_ok "node floor: 22.17 is enough" with_node v22.17.0 node_at_least 22 17
expect_ok "node floor: a later minor is enough" with_node v22.20.1 node_at_least 22 17
expect_ok "node floor: 23.0 is enough" with_node v23.0.0 node_at_least 22 17
expect_ok "node floor: 24 is enough" with_node v24.1.0 node_at_least 22 17
expect_die "node floor: 20 is too old whatever its minor" with_node v20.19.5 node_at_least 22 17
expect_die "node floor: an unreadable version is not enough" with_node garbage node_at_least 22 17
# An empty PATH directory and nothing else: no node to find.
mkdir -p "$SCRATCH/empty-path"
expect_die "node floor: no node at all is not enough" env PATH="$SCRATCH/empty-path" "$BASH" -c \
	". '$ROOT/templates/server/lib.sh' && node_at_least 22 17"

# ------------------------------------------------------------ caddy floor
#
# The same stand-in for `caddy version`, in both shapes it prints: Caddy's own
# packages say `v2.11.7 h1:...`, Ubuntu's says `2.6.2`.

fake_caddy_dir="$SCRATCH/fake-caddy"
mkdir -p "$fake_caddy_dir"
printf '#!/bin/sh\nprintf "%%s\\n" "$FAKE_CADDY_VERSION"\n' > "$fake_caddy_dir/caddy"
chmod +x "$fake_caddy_dir/caddy"
with_caddy() {
	local version=$1; shift
	FAKE_CADDY_VERSION=$version PATH="$fake_caddy_dir:$PATH" "$@"
}
expect_die "caddy floor: Ubuntu's 2.6.2 is too old" with_caddy 2.6.2 caddy_at_least 2 11
expect_die "caddy floor: 2.10 is too old" with_caddy 'v2.10.2 h1:abc=' caddy_at_least 2 11
expect_ok "caddy floor: 2.11.0 is enough" with_caddy 'v2.11.0 h1:abc=' caddy_at_least 2 11
expect_ok "caddy floor: 2.11.7 is enough" with_caddy 'v2.11.7 h1:yj0Y4fYZ=' caddy_at_least 2 11
expect_ok "caddy floor: 3.0 is enough" with_caddy v3.0.0 caddy_at_least 2 11
expect_die "caddy floor: an unreadable version is not enough" with_caddy garbage caddy_at_least 2 11
expect_die "caddy floor: no caddy at all is not enough" env PATH="$SCRATCH/empty-path" "$BASH" -c \
	". '$ROOT/templates/server/lib.sh' && caddy_at_least 2 11"

# What apply.sh writes inside each reverse_proxy block: requests that arrive
# while the app is restarting wait for it instead of failing.
expect_lines "proxy hold: retries a refused connection for 30s" \
	$'\t\tlb_try_duration 30s\n\t\tlb_try_interval 250ms' \
	caddy_proxy_hold $'\t\t'

mkdir -p "$(dirname "$(state_file hosted)")"
printf '{"url":"https://velastack.dev"}' > "$(state_file hosted)"
mkdir -p "$(dirname "$(state_file bare)")"
printf '{"url":"http://127.0.0.1:4100"}' > "$(state_file bare)"
expect_lines "health host: taken from the recorded url" 'velastack.dev' state_primary_host hosted
expect_lines "health host: none for a loopback url" '' state_primary_host bare
expect_lines "health host: none for an unknown instance" '' state_primary_host nothere

# ------------------------------------------------------------ backend flag
#
# Absent state, or state written before the flag existed, counts as having a
# backend; only an instance deployed with --backend 0 answers false.

state_merge withdb '{"webPort": 4101, "pbPort": 8101}'
state_merge nodb '{"webPort": 4102, "pbPort": 8102, "backend": false}'
state_merge withflag '{"webPort": 4103, "pbPort": 8103, "backend": true}'
[ "$(instance_backend withdb)" = true ] && ok "backend: legacy state has one" || bad "backend: legacy state has one"
[ "$(instance_backend withflag)" = true ] && ok "backend: recorded true" || bad "backend: recorded true"
[ "$(instance_backend nodb)" = false ] && ok "backend: recorded false" || bad "backend: recorded false"
[ "$(instance_backend never)" = true ] && ok "backend: no state counts as having one" || bad "backend: no state counts as having one"
expect_ok "require_backend passes with a database" require_backend withdb
expect_die "require_backend refuses without one" require_backend nodb

# ------------------------------------------------------- dependency install
#
# apply.sh skips npm altogether for a release that asks for nothing at runtime,
# drops devDependencies from the manifest it installs from when there is no
# package-lock.json, and names the out-of-memory killer when npm dies of it.

pkgs="$SCRATCH/pkgs"; mkdir -p "$pkgs"
pkg() { printf '%s' "$2" > "$pkgs/$1.json"; printf '%s' "$pkgs/$1.json"; }
expect_ok "runtime deps: devDependencies alone are none" package_without_runtime_deps \
	"$(pkg dev-only '{"scripts":{"prepare":"svelte-kit sync"},"devDependencies":{"vite":"^8.0.0"}}')"
expect_ok "runtime deps: empty objects are none" package_without_runtime_deps \
	"$(pkg empty '{"dependencies":{},"optionalDependencies":{},"devDependencies":{"vite":"^8.0.0"}}')"
expect_ok "runtime deps: a bare package.json has none" package_without_runtime_deps "$(pkg bare '{}')"
expect_die "runtime deps: a dependency is one" package_without_runtime_deps \
	"$(pkg dep '{"dependencies":{"argon2":"^0.44.0"}}')"
expect_die "runtime deps: an optional dependency is one" package_without_runtime_deps \
	"$(pkg optional '{"optionalDependencies":{"fsevents":"^2.3.3"}}')"
expect_die "runtime deps: a peer dependency is one" package_without_runtime_deps \
	"$(pkg peer '{"peerDependencies":{"svelte":"^5.0.0"}}')"
expect_die "runtime deps: workspaces are left to npm" package_without_runtime_deps \
	"$(pkg workspaces '{"workspaces":["packages/*"]}')"
expect_die "runtime deps: an unreadable package.json is left to npm" package_without_runtime_deps \
	"$(pkg broken '{not json')"
expect_die "runtime deps: a missing package.json is left to npm" package_without_runtime_deps "$pkgs/none.json"

manifest='{"scripts":{"prepare":"svelte-kit sync","start":"node build"},"dependencies":{"argon2":"^0.44.0"},"devDependencies":{"vite":"^8.0.0"}}'
manifest_after() { prepare_install_manifest "$1" "$2" && jq -c . "$1"; }
expect_lines "install manifest: without a lockfile, prepare and devDependencies go" \
	'{"scripts":{"start":"node build"},"dependencies":{"argon2":"^0.44.0"}}' \
	manifest_after "$(pkg no-lock "$manifest")" 1
expect_lines "install manifest: with a lockfile, only prepare goes" \
	'{"scripts":{"start":"node build"},"dependencies":{"argon2":"^0.44.0"},"devDependencies":{"vite":"^8.0.0"}}' \
	manifest_after "$(pkg with-lock "$manifest")" 0
untouched=$(pkg untouched '{"dependencies":{"argon2":"^0.44.0"}}')
prepare_install_manifest "$untouched" 1
[ "$(cat "$untouched")" = '{"dependencies":{"argon2":"^0.44.0"}}' ] \
	&& ok "install manifest: nothing to drop leaves the file as it was" \
	|| bad "install manifest: nothing to drop leaves the file as it was" "$(cat "$untouched")"
expect_die "install manifest: an unreadable package.json fails" prepare_install_manifest "$pkgs/broken.json" 1

printf 'MemTotal:         468356 kB\nMemFree:           12000 kB\nSwapTotal:             0 kB\n' > "$SCRATCH/meminfo"
expect_lines "meminfo: a field in megabytes" '457' meminfo_mb MemTotal "$SCRATCH/meminfo"
expect_lines "meminfo: no swap is 0" '0' meminfo_mb SwapTotal "$SCRATCH/meminfo"
expect_lines "meminfo: an unknown field is ?" '?' meminfo_mb Nope "$SCRATCH/meminfo"
expect_lines "meminfo: an unreadable file is ?" '?' meminfo_mb MemTotal "$SCRATCH/no-meminfo"
expect_lines "install failure: any other status keeps the plain message, with the code" \
	'dependency install failed (exit 1)' install_failure_message 1 "$SCRATCH/meminfo"
killed=$(install_failure_message 137 "$SCRATCH/meminfo")
if grep -q 'npm was killed (exit 137)' <<<"$killed" && grep -q 'out-of-memory killer' <<<"$killed" \
	&& grep -q '457 MB of memory and 0 MB of swap' <<<"$killed" && grep -q 'vela provision' <<<"$killed"; then
	ok "install failure: 137 names the out-of-memory killer, the memory and the way out"
else
	bad "install failure: 137 names the out-of-memory killer, the memory and the way out" "$killed"
fi

# apply.sh's install_deps itself, lifted out of the script and run against a
# stand-in npm that records how it was called and exits as told. Root-only
# commands are stubbed; the decisions and the layout left behind are real.
fake_npm_dir="$SCRATCH/fake-npm"; mkdir -p "$fake_npm_dir"
cat > "$fake_npm_dir/npm" <<'NPM'
#!/bin/sh
if [ "$1" = "-v" ]; then echo 11.6.2; exit 0; fi
printf '%s\n' "$*" > "$NPM_CALL_LOG"
cp package.json "$NPM_CALL_LOG.package.json"
mkdir -p node_modules/argon2
exit "${FAKE_NPM_EXIT:-0}"
NPM
chmod +x "$fake_npm_dir/npm"
# usage: run_install <name> <npm-exit> <package.json> [lockfile-name]
# Leaves $SCRATCH/install/<name>/{app,calls}, prints install_deps' stderr.
run_install() {
	local name=$1 npm_exit=$2 manifest=$3 lockfile=${4:-}
	local base="$SCRATCH/install/$name"
	mkdir -p "$base/app/releases/r1" "$base/app/deps"
	printf '%s' "$manifest" > "$base/app/releases/r1/package.json"
	if [ -n "$lockfile" ]; then printf 'lock' > "$base/app/releases/r1/$lockfile"; fi
	(
		set -Eeuo pipefail
		APP="$base/app" RELEASE_DIR="$base/app/releases/r1"
		export NPM_CALL_LOG="$base/calls" FAKE_NPM_EXIT=$npm_exit PATH="$fake_npm_dir:$PATH"
		chown() { :; }
		runuser() { shift 3; "$@"; }
		command -v sha256sum >/dev/null 2>&1 || sha256sum() { shasum -a 256; }
		# BSD mv has no -T; the link being replaced does not exist yet here.
		mv --version >/dev/null 2>&1 || mv() { shift; command mv -f "$@"; }
		eval "$(sed -n '/^install_deps() {$/,/^}$/p' "$ROOT/templates/server/apply.sh")"
		install_deps
	) 2>&1
}
installed_dir() { dirname "$(readlink "$SCRATCH/install/$1/app/releases/r1/node_modules")"; }

dev_only='{"scripts":{"prepare":"svelte-kit sync"},"devDependencies":{"vite":"^8.0.0"}}'
with_dep='{"scripts":{"prepare":"svelte-kit sync"},"dependencies":{"argon2":"^0.44.0"},"devDependencies":{"vite":"^8.0.0"}}'

out=$(run_install skip 0 "$dev_only" pnpm-lock.yaml); code=$?
d=$(installed_dir skip)
if [ "$code" = 0 ] && [ ! -e "$SCRATCH/install/skip/calls" ] && grep -q 'no runtime dependencies - skipping' <<<"$out" \
	&& [ -d "$d/node_modules" ] && [ -z "$(ls -A "$d/node_modules")" ] && [ -f "$d/.vela-installed" ] \
	&& [ "$(cat "$SCRATCH/install/skip/app/releases/r1/.vela-deps")" = "$(basename "$d")" ]; then
	ok "install: no runtime dependencies - npm never starts, and the keyed tree is in place"
else
	bad "install: no runtime dependencies - npm never starts, and the keyed tree is in place" "$out"
fi
out=$(run_install skip 0 "$dev_only" pnpm-lock.yaml)
grep -q 'dependencies already installed' <<<"$out" \
	&& ok "install: the skipped tree is reused by the next deploy" \
	|| bad "install: the skipped tree is reused by the next deploy" "$out"

out=$(run_install skip-lock 0 "$dev_only" package-lock.json); code=$?
[ "$code" = 0 ] && [ ! -e "$SCRATCH/install/skip-lock/calls" ] \
	&& ok "install: no runtime dependencies with a package-lock.json skips npm ci too" \
	|| bad "install: no runtime dependencies with a package-lock.json skips npm ci too" "$out"

out=$(run_install locked 0 "$with_dep" package-lock.json); code=$?
if [ "$code" = 0 ] && grep -q '^ci --omit=dev ' "$SCRATCH/install/locked/calls" \
	&& [ "$(jq -c 'del(.scripts)' "$SCRATCH/install/locked/calls.package.json")" = '{"dependencies":{"argon2":"^0.44.0"},"devDependencies":{"vite":"^8.0.0"}}' ] \
	&& [ "$(jq -r '.scripts.prepare // "gone"' "$SCRATCH/install/locked/calls.package.json")" = gone ] \
	&& [ -d "$(installed_dir locked)/node_modules/argon2" ] && [ -f "$(installed_dir locked)/.vela-installed" ]; then
	ok "install: with a package-lock.json it is npm ci on the manifest the lockfile describes"
else
	bad "install: with a package-lock.json it is npm ci on the manifest the lockfile describes" "$out $(cat "$SCRATCH/install/locked/calls" 2>&1)"
fi

out=$(run_install foreign 0 "$with_dep" pnpm-lock.yaml); code=$?
if [ "$code" = 0 ] && grep -q '^install --omit=dev ' "$SCRATCH/install/foreign/calls" \
	&& [ "$(jq -c 'del(.scripts)' "$SCRATCH/install/foreign/calls.package.json")" = '{"dependencies":{"argon2":"^0.44.0"}}' ]; then
	ok "install: without one it is npm install on a manifest with no devDependencies"
else
	bad "install: without one it is npm install on a manifest with no devDependencies" "$out"
fi

out=$(run_install killed 137 "$with_dep" pnpm-lock.yaml); code=$?
if [ "$code" = 1 ] && grep -q 'error: dependency install failed: npm was killed (exit 137)' <<<"$out" \
	&& grep -q 'out-of-memory killer' <<<"$out" \
	&& [ ! -e "$SCRATCH/install/killed/app/releases/r1/node_modules" ] \
	&& [ -z "$(find "$SCRATCH/install/killed/app/deps" -name .vela-installed)" ]; then
	ok "install: a killed npm fails the deploy, names the cause and leaves no finished tree"
else
	bad "install: a killed npm fails the deploy, names the cause and leaves no finished tree" "code=$code $out"
fi
out=$(run_install failed 1 "$with_dep" package-lock.json); code=$?
[ "$code" = 1 ] && grep -q 'error: dependency install failed (exit 1)$' <<<"$out" \
	&& ok "install: any other failure keeps its message, with the exit code" \
	|| bad "install: any other failure keeps its message, with the exit code" "code=$code $out"

# What `vela status` reports as runtimeDependencies, and `vela provision` reads
# to name the apps a new Node major leaves needing a redeploy.
rel="$SCRATCH/rel"; mkdir -p "$rel/empty" "$rel/bookkeeping" "$rel/full" "$rel/linked" "$rel/none" "$rel/deps/node_modules/argon2"
mkdir -p "$rel/empty/node_modules" "$rel/bookkeeping/node_modules" "$rel/full/node_modules/argon2"
: > "$rel/bookkeeping/node_modules/.package-lock.json"
ln -s "$rel/deps/node_modules" "$rel/linked/node_modules"
expect_die "release modules: an empty node_modules has none" release_has_modules "$rel/empty"
expect_die "release modules: npm's bookkeeping alone is none" release_has_modules "$rel/bookkeeping"
expect_die "release modules: no node_modules at all is none" release_has_modules "$rel/none"
expect_ok "release modules: an installed package is some" release_has_modules "$rel/full"
expect_ok "release modules: seen through the link into deps/" release_has_modules "$rel/linked"

# --------------------------------------------------------------------- swap
#
# `vela provision` adds a swapfile to a server with under 2 GB of memory and no
# swap, sized by what the disk can spare. The numbers are kilobytes, as
# /proc/meminfo and `df -k` give them.

gb=$((1024 * 1024))
expect_lines "swap: 458 MB, no swap, plenty of disk gets 2 GB" '2048' swap_plan 468356 0 $((20 * gb))
expect_lines "swap: a nominal 2 GB server reports less, and gets it too" '2048' swap_plan 2014300 0 $((40 * gb))
expect_lines "swap: under 8 GB free gets 1 GB" '1024' swap_plan 468356 0 $((6 * gb))
expect_lines "swap: exactly 8 GB free gets 2 GB" '2048' swap_plan 468356 0 $((8 * gb))
expect_lines "swap: under 4 GB free gets none, with a reason" 'disk' swap_plan 468356 0 $((3 * gb))
expect_lines "swap: exactly 4 GB free gets 1 GB" '1024' swap_plan 468356 0 $((4 * gb))
expect_lines "swap: 2 GB of memory needs none" 'none' swap_plan $((2 * gb)) 0 $((20 * gb))
expect_lines "swap: 8 GB of memory needs none" 'none' swap_plan $((8 * gb)) 0 $((20 * gb))
expect_lines "swap: swap that is already on is left alone" 'none' swap_plan 468356 524284 $((20 * gb))
expect_lines "swap: an existing swap outranks a full disk" 'none' swap_plan 468356 524284 $((1 * gb))
expect_lines "swap: numbers that cannot be read change nothing" 'none' swap_plan '' 0 $((20 * gb))
expect_lines "swap: an unreadable disk changes nothing" 'none' swap_plan 468356 0 ''

fstab="$SCRATCH/fstab"
printf 'LABEL=cloudimg-rootfs / ext4 discard,errors=remount-ro 0 1' > "$fstab"
fstab_add_swap /swapfile "$fstab"
fstab_add_swap /swapfile "$fstab"
[ "$(cat "$fstab")" = "$(printf 'LABEL=cloudimg-rootfs / ext4 discard,errors=remount-ro 0 1\n/swapfile none swap sw 0 0')" ] \
	&& ok "swap: the fstab line is added once, on a line of its own" \
	|| bad "swap: the fstab line is added once, on a line of its own" "$(cat "$fstab")"
fstab_add_swap /swapfile "$SCRATCH/fstab-new"
[ "$(cat "$SCRATCH/fstab-new")" = '/swapfile none swap sw 0 0' ] \
	&& ok "swap: a missing fstab is created" || bad "swap: a missing fstab is created"
printf '/swapfile2 none swap sw 0 0\n' > "$SCRATCH/fstab-other"
fstab_add_swap /swapfile "$SCRATCH/fstab-other"
[ "$(grep -c . "$SCRATCH/fstab-other")" = 2 ] \
	&& ok "swap: another swapfile's line is not taken for this one" \
	|| bad "swap: another swapfile's line is not taken for this one" "$(cat "$SCRATCH/fstab-other")"

# ------------------------------------------------------------- health gate
#
# A one-shot HTTP server that answers every request with one status code.

if command -v python3 >/dev/null 2>&1; then
	# Detached from stdout: a background child holding the substitution's pipe
	# would keep `$(serve ...)` from ever returning.
	serve() {
		local code=$1 port=$2
		python3 - "$code" "$port" >/dev/null 2>&1 <<-'PY' &
			import sys, http.server
			code, port = int(sys.argv[1]), int(sys.argv[2])
			class H(http.server.BaseHTTPRequestHandler):
			    def do_GET(self):
			        self.send_response(code); self.send_header('Content-Length', '0'); self.end_headers()
			    def log_message(self, *a): pass
			http.server.HTTPServer(('127.0.0.1', port), H).serve_forever()
			PY
		echo $!
	}
	port=$((20000 + RANDOM % 20000))
	for code in 200 302 401 403; do
		pid=$(serve "$code" "$port"); sleep 0.5
		expect_ok "health gate accepts $code" wait_for_http "http://127.0.0.1:$port/" 4 0.25
		kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
		port=$((port + 1))
	done
	for code in 404 500 503; do
		pid=$(serve "$code" "$port"); sleep 0.5
		expect_die "health gate rejects $code" wait_for_http "http://127.0.0.1:$port/" 3 0.1
		kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
		port=$((port + 1))
	done
	expect_die "health gate rejects nothing listening" wait_for_http "http://127.0.0.1:$port/" 2 0.1
else
	echo "SKIP health gate (no python3)"
fi

# ---------------------------------------------------------- removal marks
#
# destroy.sh marks an instance removed, even when nothing was there; apply.sh
# refuses a release whose deploy began at or before that mark, and lets a later
# one through.

expect_die "removed: no mark refuses nothing" removed_since_release fresh 20261005T192332Z-510d
[ -z "$(removed_at fresh)" ] && ok "removed: no mark reads empty" || bad "removed: no mark reads empty"
mark_removed gone
stamp=$(removed_at gone)
[[ $stamp =~ ^[0-9]{8}T[0-9]{6}Z$ ]] && ok "removed: mark is a server-clock stamp" || bad "removed: mark is a server-clock stamp" "$stamp"
printf '20261005T192000Z\n' > "$(removed_file gone)"
expect_ok "removed: a deploy begun before the removal is refused" removed_since_release gone 20261005T191657Z-510d
expect_ok "removed: a deploy begun in the same second is refused" removed_since_release gone 20261005T192000Z-ffff
expect_die "removed: a deploy begun after the removal goes ahead" removed_since_release gone 20261005T192001Z-0000
expect_die "removed: another instance's mark does not apply" removed_since_release other 20261005T191657Z-510d
clear_removed gone
expect_die "removed: a cleared mark refuses nothing" removed_since_release gone 20261005T191657Z-510d
[ ! -e "$(removed_file gone)" ] && ok "removed: clear_removed deletes the mark" || bad "removed: clear_removed deletes the mark"
mark_removed stale
touch -t 202001010000 "$(removed_file stale)"
mark_removed recent
[ ! -f "$(removed_file stale)" ] && [ -f "$(removed_file recent)" ] \
	&& ok "removed: marks older than 30 days are pruned" || bad "removed: marks older than 30 days are pruned"

# ------------------------------------------------------------------- lock

if command -v flock >/dev/null 2>&1; then
	# A holder that keeps the lock for three seconds.
	(lock_instance inst 0 && sleep 3) &
	holder=$!
	sleep 0.5

	out=$( (lock_instance inst 0) 2>&1 ); code=$?
	if [ "$code" != 0 ] && grep -q "is running for inst" <<<"$out"; then ok "lock: wait 0 gives up at once"; else bad "lock: wait 0 gives up at once" "$out"; fi

	out=$( (lock_instance inst 1) 2>&1 ); code=$?
	if [ "$code" != 0 ] && grep -q "still running for inst after 1s" <<<"$out"; then ok "lock: short wait times out"; else bad "lock: short wait times out" "$out"; fi

	out=$( (lock_instance inst 10 && echo acquired) 2>&1 ); code=$?
	if [ "$code" = 0 ] && grep -q "waiting for another operation on inst" <<<"$out" && grep -q acquired <<<"$out"; then ok "lock: long wait acquires after the holder exits"; else bad "lock: long wait acquires after the holder exits" "$out"; fi
	wait "$holder" 2>/dev/null

	out=$( (lock_instance other 0 && echo acquired) 2>&1 ); code=$?
	if [ "$code" = 0 ] && ! grep -q waiting <<<"$out"; then ok "lock: a different instance is independent"; else bad "lock: a different instance is independent" "$out"; fi

	[ -f "$VELA_ROOT/state/locks/inst.lock" ] && ok "lock: file lives under state/locks" || bad "lock: file lives under state/locks"

	# The caddy lock is held only between lock and unlock: a second taker must
	# not wait once the first has let go.
	out=$( (caddy_lock && caddy_unlock && caddy_lock && caddy_unlock && echo twice) 2>&1 ); code=$?
	if [ "$code" = 0 ] && grep -q twice <<<"$out"; then ok "caddy lock: releases on unlock"; else bad "caddy lock: releases on unlock" "$out"; fi
	(caddy_lock && sleep 2) &
	cholder=$!
	sleep 0.3
	start=$(date +%s)
	(caddy_lock && caddy_unlock) 2>/dev/null
	elapsed=$(( $(date +%s) - start ))
	if [ "$elapsed" -ge 1 ]; then ok "caddy lock: blocks while held"; else bad "caddy lock: blocks while held" "took ${elapsed}s"; fi
	wait "$cholder" 2>/dev/null
else
	echo "SKIP lock (no flock on this platform)"
fi

echo "passed=$pass failed=$fail"
[ "$fail" = 0 ]
