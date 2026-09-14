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
 * `~APP_NAME~`, `~SITE_URL~` and `~CMS_ENDPOINT~` are escaped for a
 * single-quoted JS string, which is the only place a template uses them.
 */
const PACKAGE_NAME_PLACEHOLDER = /~TODO~/g;
const APP_NAME_PLACEHOLDER = /~APP_NAME~/g;
const CLI_VERSION_PLACEHOLDER = /~VELA_VERSION~/g;
const SITE_URL_PLACEHOLDER = /~SITE_URL~/g;
const CMS_ENDPOINT_PLACEHOLDER = /~CMS_ENDPOINT~/g;

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
		.replace(APP_NAME_PLACEHOLDER, () => appName)
		.replace(CLI_VERSION_PLACEHOLDER, () => values.cliVersion)
		.replace(SITE_URL_PLACEHOLDER, () => siteUrl)
		.replace(CMS_ENDPOINT_PLACEHOLDER, () => cmsEndpoint);
}

function escapeSingleQuoted(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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

export function sortKeys<T extends Record<string, string>>(obj: T): T {
	const sorted: Record<string, string> = {};
	for (const key of Object.keys(obj).sort()) sorted[key] = obj[key]!;
	return sorted as T;
}
