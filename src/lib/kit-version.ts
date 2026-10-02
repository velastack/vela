import fs from 'node:fs';
import path from 'node:path';
import { findSvelteConfig } from './config-target.ts';
import { minVersion, type PkgJson } from './package-json.ts';

/**
 * Which SvelteKit a project is on, as far as vela needs to know.
 *
 * vela 0.15 writes Kit 3 code only: `#lib`, `$app/env`, config inline in
 * `sveltekit({...})`. Run against a Kit 2 project it would leave that project
 * half migrated, so the commands that write code refuse one and name the way
 * forward. A Kit 2 app pins `vela ^0.14`, and a caret on 0.x never moves it to
 * 0.15, so it only meets this guard when someone runs a newer vela by hand.
 */

const KIT = '@sveltejs/kit';

/** What upgrades a Kit 2 project, and what a Kit 2 project is told to run. */
export const KIT3_MIGRATE_COMMAND = 'npx vela@^0.15 migrate sveltekit-3';

export interface KitStatus {
	/**
	 * Major of the lowest version the package.json range admits: `^2.70.3` and
	 * `>=2` are 2, `~3.0.0` is 3. Null when `@sveltejs/kit` is not declared or
	 * the range says nothing about a version (`latest`, `workspace:*`, `*`).
	 */
	declaredMajor: number | null;
	/** Version in `node_modules/@sveltejs/kit/package.json`, when installed. */
	installedVersion?: string;
	/** Absolute path of a `svelte.config.*`, which Kit 3 refuses to start with. */
	svelteConfig: string | null;
}

export class KitVersionError extends Error {
	override name = 'KitVersionError';
	/** The command that fixes it, for a caller that wants to print it on its own line. */
	readonly command = KIT3_MIGRATE_COMMAND;
}

export function kitStatus(root: string): KitStatus {
	const pkg = readPkg(path.join(root, 'package.json'));
	// sv's migration requires kit in devDependencies, so that bucket wins a tie.
	const range = pkg?.devDependencies?.[KIT] ?? pkg?.dependencies?.[KIT];
	const status: KitStatus = {
		declaredMajor: range === undefined ? null : declaredMajor(range),
		svelteConfig: findSvelteConfig(root)
	};
	const installed = readPkg(path.join(root, 'node_modules', KIT, 'package.json'))?.version;
	if (typeof installed === 'string') status.installedVersion = installed;
	return status;
}

/**
 * The major a dependency range declares, read through the protocols that wrap
 * a range (`workspace:^3.0.0`, `npm:@sveltejs/kit@^3.0.0`). Exported for tests.
 */
export function declaredMajor(range: string): number | null {
	let spec = range.trim();
	if (spec.startsWith('workspace:')) spec = spec.slice('workspace:'.length);
	else if (spec.startsWith('npm:')) spec = spec.slice(spec.lastIndexOf('@') + 1);
	return minVersion(spec)?.major ?? null;
}

/**
 * Refuse a SvelteKit 2 project: one whose package.json declares Kit below 3,
 * or that still has a `svelte.config.*` (Kit 3 no longer reads one, and fails
 * to start while one exists). When the range says nothing (`latest`,
 * `workspace:*`), the installed version decides instead. A project with no
 * Kit at all is not this guard's business.
 *
 * `label` names the command that refused, e.g. "vela bless".
 */
export function assertKit3(root: string, label: string): void {
	const status = kitStatus(root);
	const installed = installedMajor(status.installedVersion);
	const why =
		status.declaredMajor !== null && status.declaredMajor < 3
			? `package.json declares ${KIT} ${status.declaredMajor}.x.`
			: status.declaredMajor === null && installed !== null && installed < 3
				? `It has ${KIT} ${status.installedVersion} installed.`
				: status.svelteConfig
					? `It still has ${path.basename(status.svelteConfig)}, which SvelteKit 3 no longer reads.`
					: null;
	if (!why) return;

	throw new KitVersionError(
		`${label}: SvelteKit 2 project detected. ${why}\n\n` +
			`vela 0.15 supports SvelteKit 3 only. Upgrade the project with\n\n` +
			`  ${KIT3_MIGRATE_COMMAND}\n\n` +
			`or stay on vela@0.14, which keeps working with SvelteKit 2.`
	);
}

function installedMajor(version: string | undefined): number | null {
	if (!version) return null;
	return minVersion(version)?.major ?? null;
}

function readPkg(file: string): PkgJson | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as PkgJson;
	} catch {
		return undefined;
	}
}

let warned = false;

/**
 * One line, once per process, for the commands that only run the project's
 * own toolchain (`dev`, `build`, `preview`, `test:server`): they work on
 * whatever SvelteKit the project has, but vela 0.15's generators and deploy
 * will not, so a Kit 2 project hears about it early. Never throws.
 */
export function warnIfKit2(root: string, warn: (message: string) => void): void {
	if (warned) return;
	try {
		assertKit3(root, 'vela');
	} catch (e) {
		if (!(e instanceof KitVersionError)) return;
		warned = true;
		warn(
			`SvelteKit 2 project: vela 0.15 generators and deploy need SvelteKit 3. Upgrade with \`${KIT3_MIGRATE_COMMAND}\`, or pin vela@^0.14.`
		);
	}
}
