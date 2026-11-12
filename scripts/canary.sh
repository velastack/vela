#!/usr/bin/env bash
# The canary: what a user gets from `vela create` today.
#
#   npm run canary            both built-in templates
#   npm run canary -- static  one of them
#
# Scaffolds each template from this checkout into a scratch directory, installs
# it with no lockfile (so every range resolves to the newest release it admits,
# as it does for a new user), then type-checks, builds and, where the template
# has tests, runs them.
#
# No template ships a lockfile, so a release upstream can break new projects
# with no change here. CI runs this daily for that reason, and on any change to
# the templates. It needs a built CLI: `npm run build` first.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bin="$root/dist/bin.js"
[ -f "$bin" ] || { echo "No $bin: run \`npm run build\` first." >&2; exit 1; }

templates=("$@")
[ ${#templates[@]} -gt 0 ] || templates=(minimal static)

work=$(mktemp -d "${TMPDIR:-/tmp}/vela-canary.XXXXXX")
trap 'rm -rf "$work"' EXIT

# The project's `vela` is this checkout, packed: the version in package.json
# may not be published yet, and the templates' scripts run it.
tarball="$work/$(cd "$root" && npm pack --ignore-scripts --pack-destination "$work" 2>/dev/null | tail -n 1)"

step() { printf '\n\033[1m== %s: %s\033[0m\n' "$1" "$2"; }

for template in "${templates[@]}"; do
	dir="$work/$template"
	step "$template" "vela create"
	args=(create "$dir" --template "$template" --link none --no-install --name Canary)
	if [ "$template" = minimal ]; then
		args+=(--email canary@example.com --password canary-password-1234)
	fi
	node "$bin" "${args[@]}" </dev/null

	cd "$dir"
	npm pkg set "devDependencies.vela=file:$tarball"

	step "$template" "npm install"
	npm install --no-audit --no-fund

	step "$template" "npm ls"
	npm ls >/dev/null

	step "$template" "npm run check"
	npm run check

	step "$template" "npm run build"
	npm run build

	if npm pkg get scripts.test | grep -q vitest; then
		step "$template" "npm test"
		npm test
	fi
	cd "$root"
done

printf '\n\033[1mCanary passed: %s\033[0m\n' "${templates[*]}"
