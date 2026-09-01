import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { ChildProcess } from 'node:child_process';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { x } from 'tinyexec';
import { detect } from 'package-manager-detector';
import { resolveCommand } from 'package-manager-detector/commands';
import { helpConfig } from '../lib/help.ts';
import { DATA_DIR, MIGRATIONS_DIR } from '../lib/constants.ts';
import { ensureSuperuser, startPocketbaseServe } from '../lib/pocketbase.ts';
import { findWorkspaceRoot, hasBackend } from '../lib/workspace.ts';
import { applyBuildEnv } from '../lib/build-env.ts';
import { loadDeployConfig } from '../lib/deploy-config.ts';
import { parseTarget, PRODUCTION_TARGET } from '../lib/target.ts';
import { resolveOrigin } from '../lib/origin.ts';

/** Where SvelteKit leaves the pages it rendered at build time. */
const PRERENDERED_DIR = path.join('.svelte-kit', 'output', 'prerendered');

export const build = new Command('build')
	.description('build the app')
	.configureHelp(helpConfig)
	.option('-t, --target <target>', 'which copy of the app to build for', PRODUCTION_TARGET)
	.action(async (options: { target?: string }) => {
		const cwd = process.cwd();

		applyBuildEnv(cwd);

		// Prerendering has no request to take an origin from, so the domain the
		// app is served on has to arrive as configuration or not at all.
		const origin = await originForBuild(cwd, options.target);
		if (origin) process.env.VELA_ORIGIN = origin;

		let pbProc: ChildProcess | undefined;
		// A static project has no PocketBase to start, and no `data` dir to start it from.
		const needsStart = hasBackend(cwd) && !process.env.POCKETBASE_URL;

		const cleanup = () => {
			if (pbProc?.pid) pbProc.kill();
		};

		if (needsStart) {
			await ensureSuperuser(cwd);
			const dataDir = path.join(cwd, DATA_DIR);
			const started = await startPocketbaseServe({
				dataDir,
				migrationsDir: MIGRATIONS_DIR,
				hooksDir: path.join(dataDir, 'hooks'),
				dev: true
			});
			pbProc = started.proc;
			process.env.POCKETBASE_URL = started.url;

			process.on('exit', cleanup);
			process.on('SIGINT', () => {
				cleanup();
				process.exit(0);
			});
		}

		try {
			const pm = (await detect({ cwd }))?.name ?? 'npm';
			const resolved = resolveCommand(pm, 'execute', ['vite', 'build'])!;
			const args = resolved.args.slice();
			if (pm === 'npm') args.unshift('--yes');
			await x(resolved.command, args, {
				nodeOptions: { cwd, stdio: 'inherit' },
				throwOnError: true
			});
		} finally {
			cleanup();
		}

		if (!origin) warnIfPrerendered(cwd);
	});

/**
 * The origin to render this build's absolute URLs against, if one is knowable.
 *
 * Resolution needs the workspace root rather than the cwd, and neither is worth
 * failing a build over: a project outside a workspace, or one whose target has
 * no domain yet, simply builds the way it always has.
 */
async function originForBuild(cwd: string, target: string | undefined): Promise<string | null> {
	const workspaceRootDir = findWorkspaceRoot(cwd);
	if (!workspaceRootDir) return null;

	try {
		const parsed = parseTarget(target, PRODUCTION_TARGET);
		// `local` is this machine, where `url.origin` is already the dev server's.
		if (parsed.kind !== 'remote') return null;

		const config = await loadDeployConfig(workspaceRootDir);
		return resolveOrigin(workspaceRootDir, parsed.envTag, config);
	} catch {
		return null;
	}
}

/**
 * Say so when pages were rendered against SvelteKit's placeholder host.
 *
 * Checked against the output rather than guessed from the routes beforehand,
 * because whether anything prerenders is a property of the build. Silence here
 * is what shipped `<link rel="canonical" href="http://sveltekit-prerender/">` to
 * production.
 */
function warnIfPrerendered(cwd: string): void {
	const dir = path.join(cwd, PRERENDERED_DIR);
	if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) return;

	p.log.warn(
		`Prerendered pages were built with no domain configured, so their canonical\n` +
			`links point at SvelteKit's placeholder host rather than at this site.\n\n` +
			`Set one with ${pc.cyan('vela deploy --domain example.com')}, or pass ${pc.cyan('VELA_ORIGIN')}.`
	);
}
