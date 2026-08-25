import path from 'node:path';
import process from 'node:process';
import type { ChildProcess } from 'node:child_process';
import { Command } from 'commander';
import { x } from 'tinyexec';
import { detect } from 'package-manager-detector';
import { resolveCommand } from 'package-manager-detector/commands';
import { helpConfig } from '../lib/help.ts';
import { DATA_DIR, MIGRATIONS_DIR } from '../lib/constants.ts';
import { startPocketbaseServe } from '../lib/pocketbase.ts';
import { hasBackend } from '../lib/workspace.ts';

export const preview = new Command('preview')
	.description('preview the built app')
	.configureHelp(helpConfig)
	.action(async () => {
		const cwd = process.cwd();

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

			process.on('exit', cleanup);
			process.on('SIGINT', () => {
				cleanup();
				process.exit(0);
			});
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
