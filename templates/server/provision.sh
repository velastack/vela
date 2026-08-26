#!/usr/bin/env bash
#
# Prepare a stock Ubuntu/Debian server to host vela apps.
#
# Idempotent: every step checks before it acts, so re-running after a CLI
# upgrade only fills in what is missing. It never touches an app's data, and it
# never rewrites an existing Caddyfile beyond appending one import line.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

PB_VERSION=""
NODE_MAJOR=22
CLI_VERSION="unknown"
LAYOUT_VERSION=1

while [ $# -gt 0 ]; do
	case "$1" in
		--pb-version) PB_VERSION=$2; shift 2 ;;
		--node-major) NODE_MAJOR=$2; shift 2 ;;
		--cli-version) CLI_VERSION=$2; shift 2 ;;
		*) die "unknown argument: $1" ;;
	esac
done

[ "$(id -u)" -eq 0 ] || die "provision must run as root"

. /etc/os-release
case "${ID:-}" in
	ubuntu|debian) ;;
	*) die "unsupported OS: ${PRETTY_NAME:-$ID}. vela provision supports Ubuntu and Debian." ;;
esac

export DEBIAN_FRONTEND=noninteractive
APT_UPDATED=0
apt_update_once() {
	[ "$APT_UPDATED" -eq 1 ] && return 0
	apt-get update -qq
	APT_UPDATED=1
}

ensure_packages() {
	local missing=()
	for pkg in "$@"; do
		dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
	done
	[ ${#missing[@]} -eq 0 ] && return 0
	log "installing ${missing[*]}"
	apt_update_once
	apt-get install -y -qq --no-install-recommends "${missing[@]}" >/dev/null
}

log "checking base packages"
ensure_packages ca-certificates curl gnupg rsync unzip tar sqlite3 jq git

# Native npm modules (argon2, better-sqlite3) are compiled on the server when a
# prebuild is unavailable, so the toolchain has to be here.
ensure_packages build-essential python3

install_node() {
	local current=0
	if command -v node >/dev/null 2>&1; then
		current=$(node -p 'process.versions.node.split(".")[0]')
	fi
	if [ "$current" -ge 20 ] 2>/dev/null; then
		log "node $(node -v) already installed"
		return 0
	fi
	log "installing Node.js $NODE_MAJOR"
	curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
	bash /tmp/nodesource_setup.sh >/dev/null
	rm -f /tmp/nodesource_setup.sh
	apt-get install -y -qq nodejs >/dev/null
}
install_node

install_caddy() {
	if command -v caddy >/dev/null 2>&1; then
		log "caddy $(caddy version | head -1) already installed"
		return 0
	fi
	log "installing caddy"
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
		| gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
		> /etc/apt/sources.list.d/caddy-stable.list
	apt-get update -qq
	apt-get install -y -qq caddy >/dev/null
	APT_UPDATED=1
}
install_caddy

log "creating $VELA_USER user"
if ! id -u "$VELA_USER" >/dev/null 2>&1; then
	useradd --system --home-dir "$VELA_ROOT" --shell /usr/sbin/nologin "$VELA_USER"
fi

log "creating directory layout"
mkdir -p "$VELA_ROOT"/{apps,runtime,state,scripts,by-name,cache}
mkdir -p "$VELA_ETC"/{apps,caddy}
chown -R "$VELA_USER:$VELA_USER" "$VELA_ROOT/apps" "$VELA_ROOT/state" "$VELA_ROOT/by-name" "$VELA_ROOT/cache"
chmod 0755 "$VELA_ROOT" "$VELA_ROOT/apps"
chown root:root "$VELA_ETC" "$VELA_ETC/apps"
# Env files hold production secrets; only root reads them, systemd included.
chmod 0755 "$VELA_ETC"
chmod 0700 "$VELA_ETC/apps"

log "installing PocketBase $PB_VERSION"
"$SCRIPT_DIR/pocketbase.sh" "$PB_VERSION"

log "installing systemd unit templates"
install -m 0644 "$SCRIPT_DIR/systemd/vela-web@.service" /etc/systemd/system/vela-web@.service
install -m 0644 "$SCRIPT_DIR/systemd/vela-pb@.service" /etc/systemd/system/vela-pb@.service
systemctl daemon-reload

log "wiring caddy"
# An import glob that matches nothing is a hard error in Caddy, so keep a
# comment-only file in place before the first app is deployed.
if [ ! -f "$VELA_ETC/caddy/00-vela.caddy" ]; then
	printf '# Managed by vela. App snippets are written alongside this file.\n' \
		> "$VELA_ETC/caddy/00-vela.caddy"
fi
CADDYFILE=/etc/caddy/Caddyfile
mkdir -p /etc/caddy
[ -f "$CADDYFILE" ] || printf '' > "$CADDYFILE"
if ! grep -q 'import /etc/vela/caddy/\*.caddy' "$CADDYFILE"; then
	{
		printf '\n# Added by vela provision - app routes are generated into /etc/vela/caddy.\n'
		printf 'import /etc/vela/caddy/*.caddy\n'
	} >> "$CADDYFILE"
fi
caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1 \
	|| die "existing /etc/caddy/Caddyfile is not valid after adding the vela import"
systemctl enable --now caddy >/dev/null 2>&1 || true
systemctl reload caddy 2>/dev/null || systemctl restart caddy

log "recording provisioning marker"
jq -c -n \
	--arg cli "$CLI_VERSION" \
	--arg pb "$PB_VERSION" \
	--arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
	--argjson layout "$LAYOUT_VERSION" \
	'{cliVersion: $cli, pocketbaseVersion: $pb, provisionedAt: $at, layoutVersion: $layout}' \
	> "$VELA_ETC/provisioned"
chmod 0644 "$VELA_ETC/provisioned"

emit_result \
	--arg node "$(node -v)" \
	--arg caddy "$(caddy version | head -1 | awk '{print $1}')" \
	--arg pocketbase "$PB_VERSION" \
	'{node: $node, caddy: $caddy, pocketbase: $pocketbase}'
