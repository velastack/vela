import path from 'node:path';
import process from 'node:process';
import { Command } from 'commander';
import PocketBase from 'pocketbase';
import pc from 'picocolors';
import { x } from 'tinyexec';
import { detect } from 'package-manager-detector';
import { resolveCommand } from 'package-manager-detector/commands';
import fs from 'node:fs';
import { helpConfig } from '../lib/help.ts';
import { authWithRetries, findFreePort, launchPocketbase } from '../lib/pocketbase.ts';
import { loadVite } from '../lib/vite.ts';
import type { Plugin } from 'vite';

export const testServer = new Command('test:server')
	.description('run server tests')
	.allowUnknownOption(true)
	.allowExcessArguments(true)
	.configureHelp(helpConfig)
	.action(async (_opts, cmd) => {
		const cwd = process.cwd();
		const email = `test-${Math.random().toString(36).slice(2)}@example.com`;
		const password = 'password';

		const testDataDir = path.join(cwd, 'test-data');
		fs.rmSync(testDataDir, { recursive: true, force: true });

		const { stop, url } = await launchPocketbase(cwd, {
			dir: testDataDir,
			migrationsDir: path.join(cwd, 'migrations'),
			email,
			password
		});

		process.env.POCKETBASE_URL = url;
		process.env.POCKETBASE_SUPERUSER_EMAIL = email;
		process.env.POCKETBASE_SUPERUSER_PASSWORD = password;
		process.env.TEST = 'true';

		console.log(`${pc.greenBright('✓')} Created test database`);

		const { createServer } = await loadVite(cwd);
		const vite = await createServer({
			mode: 'test',
			plugins: [stubPagesPlugin()],
			optimizeDeps: { noDiscovery: true }
		});
		const vitePort = await findFreePort();
		await vite.listen(vitePort);
		process.env.VITE_TEST_URL = `http://localhost:${vitePort}`;

		console.log(`${pc.greenBright('✓')} Started Vite: http://localhost:${vitePort}`);
		console.log(`${pc.greenBright('✓')} Started PocketBase: ${url}`);

		const cleanup = async () => {
			stop();
			await vite.close();
			fs.rmSync(testDataDir, { recursive: true, force: true });
		};

		const pb = new PocketBase(url);
		try {
			await authWithRetries(pb, email, password);
		} catch (e) {
			await cleanup();
			console.error(`${pc.redBright('✗')} Auth failed: ${(e as Error).message}`);
			process.exit(1);
		}

		const extraArgs: string[] = (cmd.parent?.args ?? []).slice(1);
		let filter = extraArgs.find((arg: string) => !arg.startsWith('-'));
		const passthrough = filter ? extraArgs.filter((a: string) => a !== filter) : extraArgs;
		if (!filter) filter = 'server';

		try {
			const pm = (await detect({ cwd }))?.name ?? 'npm';
			const resolved = resolveCommand(pm, 'execute', [
				'vitest',
				'run',
				filter,
				'--reporter=dot',
				...passthrough
			])!;
			const resolvedArgs = resolved.args.slice();
			if (pm === 'npm') resolvedArgs.unshift('--yes');
			await x(resolved.command, resolvedArgs, {
				nodeOptions: { cwd, stdio: 'inherit', env: { ...process.env, CI: '1' } },
				throwOnError: true
			});
		} catch {
			// vitest exit codes propagate up via exitCode
		} finally {
			await cleanup();
		}
	});

function stubPagesPlugin(): Plugin {
	const stub = `<script>export const render = () => '';</script>`;
	return {
		name: 'stub-pages',
		resolveId(id: string) {
			if (id.endsWith('+page.svelte')) return id;
			return undefined;
		},
		load(id: string) {
			if (
				id.endsWith('+page.svelte') ||
				id.endsWith('+layout.svelte') ||
				id.endsWith('+error.svelte')
			) {
				return stub;
			}
			return undefined;
		}
	};
}
