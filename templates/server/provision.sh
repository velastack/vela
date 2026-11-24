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
# The Node line a server is brought up to: the one releases are built with. A
# server already on a later major keeps it; see install_node.
NODE_MAJOR=26
CLI_VERSION="unknown"
LAYOUT_VERSION=1
SWAP=1

while [ $# -gt 0 ]; do
	case "$1" in
		--pb-version) PB_VERSION=$2; shift 2 ;;
		--node-major) NODE_MAJOR=$2; shift 2 ;;
		--cli-version) CLI_VERSION=$2; shift 2 ;;
		--no-swap) SWAP=0; shift ;;
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
# Ubuntu's needrestart hook prints several paragraphs of "Restarting services"
# chatter to stderr after every install. Nothing vela installs needs a service
# restart mid-provision, so skip it.
export NEEDRESTART_SUSPEND=1

# A freshly created cloud box is usually still busy on first boot: cloud-init
# runs its package step and unattended-upgrades kicks off, both holding the
# dpkg lock. Provisioning that races them fails with "Could not get lock", so
# wait for first boot to settle before touching apt.
if command -v cloud-init >/dev/null 2>&1; then
	log "waiting for cloud-init to finish"
	cloud-init status --wait >/dev/null 2>&1 || true
fi

# A small server gets a swapfile before anything is installed on it: the
# installs below, and every deploy after them, are what it is for (see
# swap_plan in lib.sh). Whatever goes wrong here is not a reason to fail the
# provision - the server is no worse off than it was. Inside a container, and
# wherever else the kernel will not take a swapfile, nothing is done or said.
SWAPFILE=/swapfile
in_container() {
	if command -v systemd-detect-virt >/dev/null 2>&1; then
		systemd-detect-virt --container --quiet 2>/dev/null
		return
	fi
	[ -f /.dockerenv ] || [ -f /run/.containerenv ]
}
ensure_swap() {
	local mem swap free plan
	[ "$SWAP" = "1" ] || return 0
	[ -r /proc/meminfo ] || return 0
	command -v swapon >/dev/null 2>&1 || return 0
	command -v mkswap >/dev/null 2>&1 || return 0
	if in_container; then return 0; fi
	mem=$(awk '$1 == "MemTotal:" { print $2; exit }' /proc/meminfo)
	swap=$(awk '$1 == "SwapTotal:" { print $2; exit }' /proc/meminfo)
	free=$(df -Pk "$(dirname "$SWAPFILE")" 2>/dev/null | awk 'NR == 2 { print $4 }' || true)
	plan=$(swap_plan "$mem" "$swap" "$free")
	case "$plan" in
		none) return 0 ;;
		disk)
			log "not adding swap: this server has $((mem / 1024)) MB of memory and no swap, but only $((free / 1024)) MB of disk is free"
			return 0
			;;
	esac
	if [ -e "$SWAPFILE" ]; then
		log "not adding swap: $SWAPFILE exists but is not in use"
		return 0
	fi
	# Created empty and private first, so its contents are never readable.
	if ! (umask 077 && : > "$SWAPFILE") 2>/dev/null; then return 0; fi
	chmod 600 "$SWAPFILE"
	# A file with holes is refused by swapon on some filesystems; where
	# fallocate cannot allocate one for real, write it out.
	if ! fallocate -l "${plan}M" "$SWAPFILE" 2>/dev/null \
		&& ! dd if=/dev/zero of="$SWAPFILE" bs=1M count="$plan" status=none 2>/dev/null; then
		rm -f "$SWAPFILE"
		log "could not create $SWAPFILE - carrying on without swap"
		return 0
	fi
	if ! mkswap "$SWAPFILE" >/dev/null 2>&1 || ! swapon "$SWAPFILE" 2>/dev/null; then
		rm -f "$SWAPFILE"
		return 0
	fi
	log "added $plan MB of swap at $SWAPFILE - this server has $((mem / 1024)) MB of memory and had none"
	fstab_add_swap "$SWAPFILE" || log "swap is on, but /etc/fstab could not be updated - it will be off after a reboot"
}
ensure_swap

APT_LOCK_TIMEOUT=${APT_LOCK_TIMEOUT:-600}
# Block until no other process holds an apt/dpkg lock, up to APT_LOCK_TIMEOUT
# seconds. Covers callers that invoke apt-get themselves (the nodesource setup
# script) and older apt without DPkg::Lock::Timeout support.
wait_for_apt() {
	local waited=0 announced=0
	command -v fuser >/dev/null 2>&1 || return 0
	while fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1; do
		[ "$announced" -eq 1 ] || { log "waiting for another apt process to finish"; announced=1; }
		[ "$waited" -lt "$APT_LOCK_TIMEOUT" ] \
			|| die "gave up waiting for the apt lock after ${APT_LOCK_TIMEOUT}s - is unattended-upgrades still running?"
		sleep 2
		waited=$((waited + 2))
	done
}

# Every apt-get call goes through here so a lock held by unattended-upgrades
# waits instead of failing the whole provision.
apt_get() {
	wait_for_apt
	apt-get -o DPkg::Lock::Timeout="$APT_LOCK_TIMEOUT" "$@"
}

APT_UPDATED=0
apt_update_once() {
	[ "$APT_UPDATED" -eq 1 ] && return 0
	apt_get update -qq
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
	apt_get install -y -qq --no-install-recommends "${missing[@]}" >/dev/null
}

log "checking base packages"
ensure_packages ca-certificates curl gnupg rsync unzip tar sqlite3 jq git

# Native npm modules (argon2, better-sqlite3) are compiled on the server when a
# prebuild is unavailable, so the toolchain has to be here.
ensure_packages build-essential python3

# The server runs the Node major that releases are built with (NODE_MAJOR, the
# action's default too), not merely one new enough to start them: npm ships with
# Node, and the server's `npm ci` has to accept the lockfile the build's npm
# wrote. npm 10 (Node 22) rejects some that npm 11 (Node 24) writes, as
# "Missing: ... from lock file". A vela project also needs 22.22, which an
# explicit `--node-major 22` still has to reach within its line. A server
# already on a later major than NODE_MAJOR is left alone.
#
# Moving a major leaves the hosted apps on dependencies compiled for the old
# one. Their running processes keep working, but each needs a redeploy (which
# installs afresh for the new ABI, see apply.sh) before it next restarts.
# The major Node was moved up from, when this run moved it: the CLI then names
# the apps to redeploy.
NODE_UPGRADED_FROM=""
install_node() {
	local current=0 line=$NODE_MAJOR previous
	if command -v node >/dev/null 2>&1; then
		current=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
	fi
	if [ "$current" -ge "$line" ] 2>/dev/null && node_at_least 22 22; then
		log "node $(node -v) already installed"
		return 0
	fi
	if [ "$current" -gt 0 ] 2>/dev/null; then
		log "upgrading Node.js $(node -v) to the latest $line.x - builds use $line"
		if [ "$current" -lt "$line" ]; then
			log "apps here whose dependencies were installed for Node $current need a redeploy - they are listed at the end"
		fi
	else
		log "installing Node.js $line"
	fi
	curl -fsSL "https://deb.nodesource.com/setup_${line}.x" -o /tmp/nodesource_setup.sh
	wait_for_apt
	# The setup script calls `apt` rather than `apt-get`, and apt prints
	# "WARNING: apt does not have a stable CLI interface" to stderr on every
	# non-interactive call - three times on a provision where nothing is wrong.
	# Drop that line (and the blank ones around it), pass everything else on.
	local status=0
	bash /tmp/nodesource_setup.sh >/dev/null 2>/tmp/nodesource_setup.err || status=$?
	grep -v -e '^WARNING: apt does not have a stable CLI interface' -e '^[[:space:]]*$' \
		/tmp/nodesource_setup.err >&2 || true
	rm -f /tmp/nodesource_setup.sh /tmp/nodesource_setup.err
	[ "$status" -eq 0 ] || die "the nodesource setup script failed (exit $status)"
	# `install` upgrades a nodejs that is already there to the candidate the
	# setup script just made available.
	apt_get install -y -qq nodejs >/dev/null
	previous=$current
	# A held package or another repository pinned above nodesource can leave the
	# old version in place with apt reporting success. Caught here, it names the
	# problem; caught by the next deploy, it would only name the symptom.
	current=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
	{ [ "$current" -ge "$line" ] 2>/dev/null && node_at_least 22 22; } \
		|| die "Node.js is $(node -v 2>/dev/null || echo 'missing') after installing $line.x - check for a held nodejs package or another repository pinned above nodesource"
	if [ "$previous" -gt 0 ] && [ "$previous" -lt "$current" ]; then NODE_UPGRADED_FROM=$previous; fi
}
install_node

# Caddy comes from its own apt repository, not the distribution's: Ubuntu 24.04
# ships 2.6.2, which cannot hold a request with a body while an app restarts
# (see CADDY_HOLD_MAJOR in lib.sh), so a form posted during a deploy gets a
# 502. A server whose Caddy is older than that is moved to the current package.
# Certificates and the Caddyfile are kept: both packages run as the `caddy`
# user out of /var/lib/caddy, and dpkg is told to keep the Caddyfile as it is.
install_caddy() {
	local had=""
	if command -v caddy >/dev/null 2>&1; then
		had=$(caddy version | head -1 | awk '{print $1}')
		if caddy_at_least "$CADDY_HOLD_MAJOR" "$CADDY_HOLD_MINOR"; then
			log "caddy $had already installed"
			return 0
		fi
		log "upgrading caddy $had - it answers 502 to form posts while an app restarts"
	else
		log "installing caddy"
	fi
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
		| gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
		> /etc/apt/sources.list.d/caddy-stable.list
	apt_get update -qq
	APT_UPDATED=1
	apt_get install -y -qq \
		-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
		caddy >/dev/null
	caddy_at_least "$CADDY_HOLD_MAJOR" "$CADDY_HOLD_MINOR" \
		|| die "Caddy is $(caddy version 2>/dev/null | head -1 | awk '{print $1}') after installing from Caddy's repository - check for a held caddy package"
	# The package restarts a running Caddy itself, but only when its own
	# maintainer script decides to; an upgrade that left the old binary
	# serving would look done and change nothing.
	if [ -n "$had" ]; then systemctl restart caddy; fi
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
	--arg memory "$(meminfo_mb MemTotal)" \
	--arg swap "$(meminfo_mb SwapTotal)" \
	--arg from "$NODE_UPGRADED_FROM" \
	'{node: $node, caddy: $caddy, pocketbase: $pocketbase, memoryMb: $memory, swapMb: $swap,
	  nodeUpgradedFrom: $from}'
