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

type PkgJson = Record<string, unknown> & {
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

export function readPackageJson(path: string): PkgJson {
	return JSON.parse(fs.readFileSync(path, 'utf8')) as PkgJson;
}

export function readTemplatePackageJson(path: string, appName: string): PkgJson {
	const raw = fs.readFileSync(path, 'utf8').replace(/~TODO~/g, toValidPackageName(appName));
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

function sortKeys<T extends Record<string, string>>(obj: T): T {
	const sorted: Record<string, string> = {};
	for (const key of Object.keys(obj).sort()) sorted[key] = obj[key]!;
	return sorted as T;
}
