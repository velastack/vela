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
