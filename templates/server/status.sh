#!/usr/bin/env bash
#
# Print the state of one instance, or every instance on the server, as JSON.
#
# usage: status.sh [instance]
set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

require_provisioned

describe() {
	local instance=$1
	local app; app=$(app_dir "$instance")
	local state="$app/state.json"
	[ -f "$state" ] || return 0

	local web_state pb_state releases current
	web_state=$(systemctl is-active "$(unit_web "$instance")" 2>/dev/null || true)
	pb_state=$(systemctl is-active "$(unit_pb "$instance")" 2>/dev/null || true)
	current=$([ -L "$app/current" ] && basename "$(readlink -f "$app/current")" || echo "")
	releases=$(ls -1 "$app/releases" 2>/dev/null | sort -r | jq -R . | jq -sc .)

	jq -c \
		--arg web "$web_state" --arg pb "$pb_state" --arg current "$current" \
		--argjson releases "$releases" \
		'. + {services: {web: $web, pocketbase: $pb}, current: $current, releases: $releases}' \
		"$state"
}

collect() {
	if [ $# -ge 1 ] && [ -n "$1" ]; then
		describe "$1"
	else
		for dir in "$VELA_ROOT"/apps/*/; do
			[ -d "$dir" ] || continue
			describe "$(basename "$dir")"
		done
	fi
}

printf 'VELA_RESULT %s\n' "$(collect "$@" | jq -sc .)"
