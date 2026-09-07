#!/usr/bin/env bash
#
# Publish this server's origin site: the one hostname the velastack.app Worker
# proxies managed hostnames to.
#
# Reads /etc/vela/origin.json, which the CLI writes after registering the
# server with velastack.dev. The site block refuses anything without the
# server's token, then hands matching requests to per-instance route files
# that apply.sh writes under routes/. Idempotent, and quiet when nothing has
# changed, so a deploy does not reload Caddy for no reason.
#
# usage: origin.sh
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_provisioned
[ "$(id -u)" -eq 0 ] || die "origin must run as root"

ORIGIN_FILE="$VELA_ETC/origin.json"
[ -f "$ORIGIN_FILE" ] || die "$ORIGIN_FILE is missing - the CLI registers the server before running this"

HOST=$(jq -er .originHost "$ORIGIN_FILE") || die "$ORIGIN_FILE has no originHost"
TOKEN=$(jq -er .token "$ORIGIN_FILE") || die "$ORIGIN_FILE has no token"

ROUTES="$VELA_ETC/caddy/routes"
mkdir -p "$ROUTES"
chmod 0755 "$ROUTES"
# An import glob that matches nothing is a hard error in Caddy, so keep a
# comment-only file in place before the first managed instance is deployed.
if [ ! -f "$ROUTES/00-vela.route" ]; then
	printf '# Managed by vela. Instance routes are written alongside this file.\n' \
		> "$ROUTES/00-vela.route"
fi

SNIPPET="$VELA_ETC/caddy/00-origin.caddy"
desired=$(
	printf '# Managed by vela - origin for velastack.app managed hostnames\n'
	printf '%s {\n' "$HOST"
	printf '\t@untrusted not header X-Velastack-Origin-Token "%s"\n' "$TOKEN"
	printf '\thandle @untrusted {\n\t\trespond 403\n\t}\n'
	printf '\timport %s/*.route\n' "$ROUTES"
	printf '\thandle {\n\t\trespond 404\n\t}\n'
	printf '}\n'
)

if [ -f "$SNIPPET" ] && [ "$(cat "$SNIPPET")" = "$desired" ]; then
	emit_result --arg host "$HOST" '{originHost: $host, changed: false}'
	exit 0
fi

tmp=$(mktemp "$VELA_ETC/caddy/.origin.XXXXXX")
printf '%s\n' "$desired" > "$tmp"
# Readable by the caddy user (which is what `caddy reload` runs as) and no one
# else: the token must not leak to the apps, which run as $VELA_USER.
caddy_install "$tmp" "$SNIPPET" 0640 root:caddy \
	|| die "generated origin config for $HOST is invalid"
caddy_reload

emit_result --arg host "$HOST" '{originHost: $host, changed: true}'
