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
import { DATA_DIR, MIGRATIONS_DIR } from '../lib/constants.ts';
import { DataLoadError, loadFixtures, loadSeeds } from '../lib/data.ts';
import { loadVite } from '../lib/vite.ts';
import type { Plugin, ViteDevServer } from 'vite';

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
			migrationsDir: path.join(cwd, MIGRATIONS_DIR),
			// The app's PocketBase hooks (slug generation, personal teams, …) are part
			// of its behaviour; the suite runs against the same server dev and build
			// start, so it loads them from the same place.
			hooksDir: path.join(cwd, DATA_DIR, 'hooks'),
			email,
			password
		});

		process.env.POCKETBASE_URL = url;
		process.env.POCKETBASE_SUPERUSER_EMAIL = email;
		process.env.POCKETBASE_SUPERUSER_PASSWORD = password;
		// The app's data directory is PocketBase's, here as everywhere else. It
		// points at the throwaway one so that a database or an uploaded file the
		// suite creates is removed with it, rather than accumulating in the
		// directory the developer actually works against.
		process.env.VELA_DATA_DIR = testDataDir;
		process.env.TEST = 'true';

		console.log(`${pc.greenBright('✓')} Created test database`);

		let vite: ViteDevServer | undefined;
		let cleanedUp = false;
		// Synchronous so it can run from an exit or signal handler; Vite's close
		// is async and is only awaited on the normal path.
		const cleanupSync = () => {
			if (cleanedUp) return;
			cleanedUp = true;
			stop();
			fs.rmSync(testDataDir, { recursive: true, force: true });
		};
		const cleanup = async () => {
			if (cleanedUp) return;
			await vite?.close().catch(() => {});
			cleanupSync();
		};
		const fail = async (message: string): Promise<never> => {
			console.error(`${pc.redBright('✗')} ${message}`);
			await cleanup();
			process.exit(1);
		};
		process.on('exit', cleanupSync);
		process.on('SIGINT', () => {
			cleanupSync();
			process.exit(130);
		});

		const pb = new PocketBase(url);
		try {
			await authWithRetries(pb, email, password);
		} catch (e) {
			await fail(`Auth failed: ${(e as Error).message}`);
		}

		// Seeds are the data the app needs to function and fixtures are its test
		// data, so the test database carries both. They go in through the running
		// server so the app's hooks apply to them as they would to any write.
		try {
			const seeds = await loadSeeds(pb, cwd);
			if (seeds.length > 0) {
				console.log(`${pc.greenBright('✓')} Loaded ${seeds.length} seed file(s)`);
			}
			const fixtures = await loadFixtures(pb, cwd);
			if (fixtures.length > 0) {
				console.log(`${pc.greenBright('✓')} Loaded ${fixtures.length} fixture file(s)`);
			}
		} catch (e) {
			await fail(describeLoadFailure(e));
		}

		const { createServer } = await loadVite(cwd);
		vite = await createServer({
			mode: 'test',
			plugins: [stubPagesPlugin()],
			optimizeDeps: { noDiscovery: true }
		});
		const vitePort = await findFreePort();
		await vite.listen(vitePort);
		process.env.VITE_TEST_URL = `http://localhost:${vitePort}`;

		console.log(`${pc.greenBright('✓')} Started Vite: http://localhost:${vitePort}`);
		console.log(`${pc.greenBright('✓')} Started PocketBase: ${url}`);

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
			const result = await x(resolved.command, resolvedArgs, {
				nodeOptions: { cwd, stdio: 'inherit', env: { ...process.env, CI: '1' } }
			});
			// A failing suite is this command failing: CI reads the exit code.
			process.exitCode = result.exitCode ?? 1;
		} catch (e) {
			console.error(`${pc.redBright('✗')} ${(e as Error).message}`);
			process.exitCode = 1;
		} finally {
			await cleanup();
		}
	});

function describeLoadFailure(e: unknown): string {
	if (e instanceof DataLoadError) {
		const hint =
			e.kind === 'fixtures'
				? 'Run `vela fixtures regen` to regenerate fixtures from the current schema.'
				: `Check ${e.file} against the current schema.`;
		return `Failed to load ${e.message}\n  ${hint}`;
	}
	return `Failed to load test data: ${(e as Error).message}`;
}

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
