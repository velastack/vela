#!/usr/bin/env bash
# The canary: what a user gets from `vela create`, and from the first
# generators they run in it, today.
#
#   npm run canary            both built-in templates
#   npm run canary -- static  one of them
#
# Scaffolds each template from this checkout into a scratch directory, installs
# it with no lockfile (so every range resolves to the newest release it admits,
# as it does for a new user), then type-checks, builds and, where the template
# has tests, runs them.
#
# The minimal template then goes on to what the README's first day does:
# `vela enable auth` and `vela generate scaffold`, once with form actions and
# once with `--remote`, each followed by lint, check, build and test. The
# generators pull from registries this repository does not pin (shadcn-svelte's
# for one), so a change there breaks `vela enable auth` with no change here.
# The `--remote` run works on a copy of the installed project, made before any
# generator ran, so there is one install for all three.
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

# Check, build and test the project in the current directory. With `lint` as
# the second argument, its own `prettier --check` first: what a generator
# writes has to pass it.
verify() {
	local label=$1
	if [ "${2:-}" = lint ]; then
		step "$label" "npm run lint"
		npm run lint
	fi

	step "$label" "npm run check"
	npm run check

	step "$label" "npm run build"
	npm run build

	if npm pkg get scripts.test | grep -q vitest; then
		step "$label" "npm test"
		npm test
	fi
}

# Run the project's own vela (the packed checkout), as a user's `npx vela`
# does. `CI` and the closed stdin keep it from asking anything.
vela() {
	step "$1" "vela ${*:2}"
	CI=1 npx --no-install vela "${@:2}" </dev/null
}

# What the first day in a new project runs. Extra arguments (`--remote`) go to
# both generators.
generators() {
	local label=$1
	shift
	vela "$label" enable auth "$@"
	vela "$label" generate scaffold post title:text body:editor "$@"
	verify "$label" lint
}

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

	# Generators need the backend, so only the minimal template runs them. The
	# copy for the `--remote` run is taken now, installed and untouched.
	if [ "$template" = minimal ]; then
		cp -a "$dir" "$work/$template-remote"
	fi

	verify "$template"

	if [ "$template" = minimal ]; then
		generators "$template + auth"

		cd "$work/$template-remote"
		generators "$template + auth --remote" --remote
	fi
	cd "$root"
done

printf '\n\033[1mCanary passed: %s\033[0m\n' "${templates[*]}"
