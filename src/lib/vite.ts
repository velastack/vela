import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import pc from 'picocolors';

/**
 * The vite major the inline server configs in `vela dev` and `vela test:server`
 * are written against.
 */
export const REQUIRED_VITE_MAJOR = 8;

/**
 * Returns an error message when `version` is too old for those inline configs,
 * or null when it is usable.
 *
 * An unparseable version returns null. A prerelease or fork string is not
 * evidence of a problem, and refusing to start over one we simply failed to
 * read would be worse than letting vite speak for itself.
 */
export function viteVersionError(version: string): string | null {
	const major = Number.parseInt(version, 10);
	if (!Number.isFinite(major) || major >= REQUIRED_VITE_MAJOR) return null;

	return [
		`This project has vite ${version}, but vela needs vite ${REQUIRED_VITE_MAJOR} or newer.`,
		'',
		'  npm install -D vite@^8 @sveltejs/vite-plugin-svelte@^7',
		'',
		'Both move together: @sveltejs/vite-plugin-svelte 7 requires vite 8, and',
		'version 6 is the last that supports vite 7.'
	].join('\n');
}

/**
 * Resolves the `vite` entry point as seen from `cwd`, or null when the project
 * has none.
 */
function resolveProjectVite(cwd: string): string | null {
	try {
		return createRequire(path.join(cwd, 'package.json')).resolve('vite');
	} catch {
		return null;
	}
}

/**
 * Loads the vite the *project* will actually be built with, and checks we can
 * drive it.
 *
 * Resolving from `cwd` rather than importing `vite` bare matters: a bare import
 * resolves relative to this file, which is the project's own `node_modules` for
 * a normal install but the CLI's for a global install, an `npx` run, or a linked
 * dev checkout. Since `createServer` reads the project's `vite.config.ts` either
 * way, a bare import can pair the project's config with a different vite than
 * the project declares.
 *
 * Falls back to a bare import when the project has no vite of its own, which
 * keeps `--help`-shaped and scratch invocations working.
 */
export async function loadVite(cwd: string = process.cwd()): Promise<typeof import('vite')> {
	const entry = resolveProjectVite(cwd);
	const vite: typeof import('vite') = entry
		? await import(pathToFileURL(entry).href)
		: await import('vite');

	const error = viteVersionError(vite.version);
	if (error) {
		console.error(`${pc.redBright('✗')} ${error}`);
		process.exit(1);
	}
	return vite;
}
