import fs from 'node:fs';

export type DepKind = 'dependencies' | 'devDependencies';
const DEP_KINDS: DepKind[] = ['dependencies', 'devDependencies'];

export interface MergeChange {
	kind: DepKind | 'scripts';
	name: string;
	templateValue: string;
	userValue?: string;
}

export interface MergeResult {
	merged: Record<string, unknown>;
	added: MergeChange[];
	conflicts: MergeChange[];
	replaced: MergeChange[];
}

export type PkgJson = Record<string, unknown> & {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	scripts?: Record<string, string>;
};

export function mergePackageJson(user: PkgJson, template: PkgJson): MergeResult {
	const merged: PkgJson = structuredClone(user);
	const added: MergeChange[] = [];
	const conflicts: MergeChange[] = [];
	const replaced: MergeChange[] = [];

	for (const kind of DEP_KINDS) {
		const templateDeps = template[kind];
		if (!templateDeps) continue;

		const userDeps = (merged[kind] ??= {}) as Record<string, string>;
		const otherKind: DepKind = kind === 'dependencies' ? 'devDependencies' : 'dependencies';
		const userOther = (user[otherKind] ?? {}) as Record<string, string>;

		for (const [name, templateValue] of Object.entries(templateDeps)) {
			if (name in userDeps) {
				if (userDeps[name] !== templateValue) {
					conflicts.push({ kind, name, templateValue, userValue: userDeps[name] });
				}
				continue;
			}
			if (name in userOther) {
				// already pinned in the other bucket — leave it there, don't duplicate.
				continue;
			}
			userDeps[name] = templateValue;
			added.push({ kind, name, templateValue });
		}
	}

	const templateScripts = template.scripts;
	if (templateScripts) {
		const userScripts = (merged.scripts ??= {}) as Record<string, string>;
		for (const [name, templateValue] of Object.entries(templateScripts)) {
			const existing = userScripts[name];
			if (existing === undefined) {
				userScripts[name] = templateValue;
				added.push({ kind: 'scripts', name, templateValue });
				continue;
			}
			if (existing === templateValue) continue;
			userScripts[name] = templateValue;
			replaced.push({ kind: 'scripts', name, templateValue, userValue: existing });
		}
	}

	for (const kind of DEP_KINDS) {
		const deps = merged[kind];
		if (deps) merged[kind] = sortKeys(deps);
	}

	return { merged, added, conflicts, replaced };
}

/**
 * Leave a template's SvelteKit adapter out of the merge when the project has
 * one of its own. The adapter is the project's decision: a project deploying
 * somewhere adapter-node does not serve would otherwise get the template's
 * adapter added beside its own. Returns a copy.
 */
export function dropTemplateAdapters(user: PkgJson, template: PkgJson): PkgJson {
	const isAdapter = (name: string) => name.startsWith('@sveltejs/adapter-');
	const userHasOne = DEP_KINDS.some((kind) => Object.keys(user[kind] ?? {}).some(isAdapter));
	if (!userHasOne) return template;
	const copy: PkgJson = { ...template };
	for (const kind of DEP_KINDS) {
		const deps = template[kind];
		if (!deps) continue;
		copy[kind] = Object.fromEntries(Object.entries(deps).filter(([name]) => !isAdapter(name)));
	}
	return copy;
}

export function readPackageJson(path: string): PkgJson {
	return JSON.parse(fs.readFileSync(path, 'utf8')) as PkgJson;
}

/**
 * Placeholders a template file carries so it stays valid on disk while still
 * being parameterized. `~TODO~` becomes the npm-safe package name and
 * `~APP_NAME~` the name the user actually typed; the CLI writes its own version
 * into `~VELA_VERSION~` so a generated project pins the exact CLI that produced
 * it, rather than whatever was hardcoded when the template was last edited.
 *
 * `~SITE_URL~` and `~CMS_ENDPOINT~` are the two per-site values a static
 * template's `src/lib/site.ts` carries: where the site is served, and the
 * hosted CMS it reads its copy from (empty when there is none yet). The
 * templates repository fills the same placeholders when it prebuilds a
 * template for velastack.dev's instant deploys, so a template author only ever
 * writes them once.
 *
 * `~APP_NAME~`, `~SITE_URL~` and `~CMS_ENDPOINT~` stand inside a single-quoted
 * JS string, which is the only place a template uses them. Those quotes are
 * replaced along with the placeholder so the value decides them: an app name
 * holding an apostrophe becomes `"Nathan's App"` rather than an escaped
 * `'Nathan\'s App'`, which prettier rewrites — a fresh project would fail its
 * own `npm run lint`. A placeholder standing outside quotes is still filled,
 * escaped for the single-quoted string it is assumed to sit in.
 */
const PACKAGE_NAME_PLACEHOLDER = /~TODO~/g;
const APP_NAME_PLACEHOLDER = /~APP_NAME~/g;
const CLI_VERSION_PLACEHOLDER = /~VELA_VERSION~/g;
const SITE_URL_PLACEHOLDER = /~SITE_URL~/g;
const CMS_ENDPOINT_PLACEHOLDER = /~CMS_ENDPOINT~/g;
const QUOTED_APP_NAME_PLACEHOLDER = /'~APP_NAME~'/g;
const QUOTED_SITE_URL_PLACEHOLDER = /'~SITE_URL~'/g;
const QUOTED_CMS_ENDPOINT_PLACEHOLDER = /'~CMS_ENDPOINT~'/g;

/** Where a freshly created site is served until it is deployed. */
export const LOCAL_SITE_URL = 'http://localhost:5173';

export interface TemplateValues {
	appName: string;
	cliVersion: string;
	/** Defaults to the dev server; a deployed project sets its own. */
	siteUrl?: string;
	/** The hosted CMS `site.cmsEndpoint` reads from; empty leaves the site offline. */
	cmsEndpoint?: string;
}

/** Substitute template placeholders in a raw template source string. */
export function fillTemplatePlaceholders(raw: string, values: TemplateValues): string {
	const packageName = toValidPackageName(values.appName);
	const appName = escapeSingleQuoted(values.appName);
	const siteUrl = escapeSingleQuoted(values.siteUrl ?? LOCAL_SITE_URL);
	const cmsEndpoint = escapeSingleQuoted(values.cmsEndpoint ?? '');
	// Function replacements: `$&` and friends in an app name are literal text.
	return raw
		.replace(PACKAGE_NAME_PLACEHOLDER, () => packageName)
		.replace(QUOTED_APP_NAME_PLACEHOLDER, () => jsString(values.appName))
		.replace(QUOTED_SITE_URL_PLACEHOLDER, () => jsString(values.siteUrl ?? LOCAL_SITE_URL))
		.replace(QUOTED_CMS_ENDPOINT_PLACEHOLDER, () => jsString(values.cmsEndpoint ?? ''))
		.replace(APP_NAME_PLACEHOLDER, () => appName)
		.replace(CLI_VERSION_PLACEHOLDER, () => values.cliVersion)
		.replace(SITE_URL_PLACEHOLDER, () => siteUrl)
		.replace(CMS_ENDPOINT_PLACEHOLDER, () => cmsEndpoint);
}

function escapeSingleQuoted(value: string): string {
	return escapeFor("'", value);
}

function escapeFor(quote: '"' | "'", value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.split(quote)
		.join(`\\${quote}`)
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r');
}

/**
 * `value` as a JS string literal quoted the way prettier would leave it under
 * the templates' `singleQuote: true`: single quotes, unless the value holds
 * more of them than double quotes and double quoting means less escaping.
 */
export function jsString(value: string): string {
	const count = (quote: string) => value.split(quote).length - 1;
	const quote = count("'") > count('"') ? '"' : "'";
	return `${quote}${escapeFor(quote, value)}${quote}`;
}

export function readTemplatePackageJson(path: string, values: TemplateValues): PkgJson {
	const raw = fillTemplatePlaceholders(fs.readFileSync(path, 'utf8'), values);
	return JSON.parse(raw) as PkgJson;
}

export function writePackageJson(path: string, pkg: Record<string, unknown>): void {
	fs.writeFileSync(path, JSON.stringify(pkg, null, '\t') + '\n');
}

export function toValidPackageName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/^[._]/, '')
		.replace(/[^a-z0-9~.-]+/g, '-');
}

/**
 * The subpath imports SvelteKit 3 resolves `#lib` through, now that `$lib` is
 * gone. The same two entries `sv create` writes.
 */
export const LIB_IMPORTS: Record<string, string> = {
	'#lib': './src/lib/index.js',
	'#lib/*': './src/lib/*'
};

/**
 * Add the `#lib` subpath imports to package.json where they are missing. An
 * entry already there is the project's, whatever it points at, and is never
 * overwritten; an `imports` field that is not an object is not ours to
 * restructure. Mutates `pkg`; returns whether it changed.
 */
export function ensureLibImports(pkg: PkgJson): boolean {
	const current = pkg.imports;
	if (current !== undefined && (typeof current !== 'object' || current === null)) return false;
	if (Array.isArray(current)) return false;
	const imports = { ...(current as Record<string, unknown> | undefined) };
	let changed = false;
	for (const [key, value] of Object.entries(LIB_IMPORTS)) {
		if (key in imports) continue;
		imports[key] = value;
		changed = true;
	}
	if (changed) pkg.imports = imports;
	return changed;
}

/**
 * Raise the range `name` is declared with to `range`, if what it declares now
 * admits anything older. Never adds a dependency the project does not have and
 * never lowers one: only the lowest version each range admits is compared, so
 * `~6.1.0` already satisfies a floor of `^6.0.0`. A range we cannot read
 * (`workspace:*`, `latest`, a git URL) is the project's decision and is left
 * alone. Mutates `pkg`; returns whether it changed.
 */
export function raiseFloor(pkg: PkgJson, name: string, range: string): boolean {
	const floor = minVersion(range);
	if (!floor) throw new Error(`raiseFloor: cannot read the range ${range}`);
	let changed = false;
	for (const kind of DEP_KINDS) {
		const current = pkg[kind]?.[name];
		if (current === undefined || current.includes(':')) continue;
		const min = minVersion(current);
		if (!min || compareVersions(min, floor) >= 0) continue;
		pkg[kind]![name] = range;
		changed = true;
	}
	return changed;
}

export interface Version {
	major: number;
	minor: number;
	patch: number;
	/** Dot-separated prerelease identifiers; empty for a release. */
	prerelease: string[];
}

const VERSION_PART =
	/^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The lowest version an npm range admits, or null when it is not a semver
 * range at all (`latest`, `workspace:*`, a URL) or admits everything (`*`).
 * A small subset of node-semver's `minVersion`, enough for the ranges package
 * managers and humans write: `^`, `~`, comparators, x-ranges, hyphen ranges and
 * `||` (the lowest alternative wins). A range bounded only from above
 * (`<3`) admits 0.0.0.
 */
export function minVersion(range: string): Version | null {
	const alternatives = range.split('||').map((alt) => alt.trim());
	let lowest: Version | null = null;
	for (const alt of alternatives) {
		const min = minOfComparatorSet(alt);
		if (!min) return null;
		if (!lowest || compareVersions(min, lowest) < 0) lowest = min;
	}
	return lowest;
}

function minOfComparatorSet(set: string): Version | null {
	// `1.2.3 - 2.0.0`: the left side is the floor.
	const hyphen = set.match(/^(\S+)\s+-\s+\S+$/);
	const parts = hyphen ? [hyphen[1]!] : set.replace(/([<>=~^]+)\s+/g, '$1').split(/\s+/);
	if (parts.every((part) => part === '')) return null;
	let floor: Version | null = null;
	let upperOnly = true;
	for (const part of parts) {
		if (part === '') continue;
		const match = part.match(/^(<=|>=|<|>|=|\^|~>?)?(.*)$/)!;
		const op = match[1] ?? '';
		if (op === '<' || op === '<=') continue;
		upperOnly = false;
		const parsed = parseVersionPart(match[2]!);
		if (!parsed) return null;
		let min = parsed.version;
		// `>1.2.3` admits 1.2.4 and up; `>1.2` admits 1.3.0. Close enough for a floor.
		if (op === '>') {
			min = parsed.wildcard
				? bump(min, parsed.wildcard)
				: { ...min, patch: min.patch + 1, prerelease: [] };
		}
		if (!floor || compareVersions(min, floor) > 0) floor = min;
	}
	if (upperOnly) return { major: 0, minor: 0, patch: 0, prerelease: [] };
	return floor;
}

function parseVersionPart(
	text: string
): { version: Version; wildcard?: 'major' | 'minor' | 'patch' } | null {
	if (text === '' || text === '*' || text === 'x' || text === 'X') return null;
	const match = text.match(VERSION_PART);
	if (!match) return null;
	const nums = [match[1], match[2], match[3]];
	const firstWild = nums.findIndex((n) => n === undefined || /^[xX*]$/.test(n));
	if (firstWild === 0) return null;
	const [major, minor, patch] = nums.map((n, i) =>
		firstWild !== -1 && i >= firstWild ? 0 : Number(n)
	) as [number, number, number];
	return {
		version: { major, minor, patch, prerelease: match[4]?.split('.') ?? [] },
		wildcard: firstWild === 1 ? 'major' : firstWild === 2 ? 'minor' : undefined
	};
}

function bump(version: Version, part: 'major' | 'minor' | 'patch'): Version {
	if (part === 'major') return { major: version.major + 1, minor: 0, patch: 0, prerelease: [] };
	if (part === 'minor') return { ...version, minor: version.minor + 1, patch: 0, prerelease: [] };
	return { ...version, patch: version.patch + 1, prerelease: [] };
}

/** Semver precedence: a release outranks its prereleases, identifiers compare numerically where they can. */
export function compareVersions(a: Version, b: Version): number {
	for (const key of ['major', 'minor', 'patch'] as const) {
		if (a[key] !== b[key]) return a[key] - b[key];
	}
	if (a.prerelease.length === 0 || b.prerelease.length === 0) {
		return b.prerelease.length - a.prerelease.length;
	}
	for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
		const x = a.prerelease[i];
		const y = b.prerelease[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		if (x === y) continue;
		const xn = /^\d+$/.test(x);
		const yn = /^\d+$/.test(y);
		if (xn && yn) return Number(x) - Number(y);
		if (xn !== yn) return xn ? -1 : 1;
		return x < y ? -1 : 1;
	}
	return 0;
}

export function sortKeys<T extends Record<string, string>>(obj: T): T {
	const sorted: Record<string, string> = {};
	for (const key of Object.keys(obj).sort()) sorted[key] = obj[key]!;
	return sorted as T;
}
