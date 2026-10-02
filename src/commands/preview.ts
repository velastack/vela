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
import { onTerminate } from '../lib/terminate.ts';
import { DATA_DIR, MIGRATIONS_DIR } from '../lib/constants.ts';
import { startPocketbaseServe } from '../lib/pocketbase.ts';
import { findWorkspaceRoot, hasBackend, localDataDir } from '../lib/workspace.ts';
import { warnIfKit2 } from '../lib/kit-version.ts';
import { isLocalUrl } from '../lib/site.ts';

/** Where adapter-node 6 writes the values only known after a build, `origin` among them. */
const ADAPTER_NODE_MODULE = path.join('build', 'adapter-node.js');

export const preview = new Command('preview')
	.description('preview the built app')
	.configureHelp(helpConfig)
	.action(async () => {
		const cwd = process.cwd();

		// Every other context reads the data directory out of the environment, so
		// the one this machine uses has to be there too — otherwise the fallback
		// is the only code path local development ever exercises.
		process.env.VELA_DATA_DIR ??= localDataDir(cwd);

		warnIfKit2(findWorkspaceRoot(cwd) ?? cwd, (m) => p.log.warn(m));
		warnIfOriginBaked(cwd);

		let pbProc: ChildProcess | undefined;
		// A static project has no PocketBase to start, and no `data` dir to start it from.
		const needsStart = hasBackend(cwd) && !process.env.POCKETBASE_URL;

		const cleanup = () => {
			if (pbProc?.pid) pbProc.kill();
		};

		if (needsStart) {
			const dataDir = path.join(cwd, DATA_DIR);
			const started = await startPocketbaseServe({
				dataDir,
				migrationsDir: MIGRATIONS_DIR,
				hooksDir: path.join(dataDir, 'hooks'),
				dev: true
			});
			pbProc = started.proc;
			process.env.POCKETBASE_URL = started.url;

			onTerminate(cleanup);
		}

		try {
			const pm = (await detect({ cwd }))?.name ?? 'npm';
			const resolved = resolveCommand(pm, 'execute', ['vite', 'preview'])!;
			const args = resolved.args.slice();
			if (pm === 'npm') args.unshift('--yes');
			await x(resolved.command, args, {
				nodeOptions: { cwd, stdio: 'inherit' },
				throwOnError: true
			});
		} finally {
			cleanup();
		}
	});

/**
 * The `paths.origin` a build baked into adapter-node's output, or null for none.
 *
 * adapter-node 6 writes it as `export const origin = <JSON>;`, which serialises
 * an unset one as `""` or as `undefined` — neither of which is an origin.
 */
export function bakedOrigin(source: string): string | null {
	const match = /^export const origin = ("(?:[^"\\]|\\.)*");$/m.exec(source);
	if (!match) return null;
	try {
		const value: unknown = JSON.parse(match[1]);
		return typeof value === 'string' && value ? value : null;
	} catch {
		return null;
	}
}

/**
 * Say so when the build being previewed belongs to a public domain.
 *
 * Under SvelteKit 3 a baked `paths.origin` is every request's `url.origin`, and
 * what the CSRF check compares a form post's `Origin` with. A build made for a
 * deployed target and previewed here therefore refuses every form submitted
 * from localhost with a 403, which looks like a broken form rather than the
 * wrong build.
 */
function warnIfOriginBaked(cwd: string): void {
	let source: string;
	try {
		source = fs.readFileSync(path.join(cwd, ADAPTER_NODE_MODULE), 'utf8');
	} catch {
		return;
	}
	const origin = bakedOrigin(source);
	if (!origin || isLocalUrl(origin)) return;

	p.log.warn(
		`This build was made for ${pc.cyan(origin)}, and SvelteKit treats that as the origin of\n` +
			`every request. Form posts from localhost will be refused as cross-site (403).\n\n` +
			`Build for this machine first: ${pc.cyan('vela build -t local')}, or with ${pc.cyan('VELA_ORIGIN=')}\n` +
			`set empty so no domain is baked in.`
	);
}
