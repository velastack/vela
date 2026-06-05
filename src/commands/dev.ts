import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { Command } from 'commander';
import pc from 'picocolors';
import PocketBase from 'pocketbase';
import { helpConfig } from '../lib/help.ts';
import { DATA_DIR, MIGRATIONS_DIR } from '../lib/constants.ts';
import { startPocketbaseServe } from '../lib/pocketbase.ts';

export const dev = new Command('dev')
	.description('start the development server')
	.configureHelp(helpConfig)
	.action(async () => {
		const cwd = process.cwd();
		const startTime = performance.now();

		const { createServer, version } = await import('vite');

		const viteMetadataDir = path.join(cwd, 'node_modules', '.vite');
		const viteMetadataFile = path.join(viteMetadataDir, '_pocketbase_metadata.json');

		let pbProc: ChildProcess | undefined;
		const needsStart = !process.env.POCKETBASE_URL;

		const cleanup = () => {
			if (pbProc?.pid) pbProc.kill();
			if (fs.existsSync(viteMetadataFile)) fs.rmSync(viteMetadataFile);
		};

		if (needsStart) {
			const dataDir = path.join(cwd, DATA_DIR);
			const started = await startPocketbaseServe({
				dataDir,
				migrationsDir: MIGRATIONS_DIR,
				hooksDir: path.join(dataDir, 'hooks'),
				dev: true,
				stdio: 'pipe'
			});
			pbProc = started.proc;
			process.env.POCKETBASE_URL = started.url;

			pbProc.stdout?.pipe(process.stdout);
			pbProc.stderr?.pipe(process.stderr);
			pbProc.on('error', (err) => console.error('PocketBase error:', err));
			pbProc.on('exit', (code) => console.log(`PocketBase exited with code ${code}`));

			process.on('exit', cleanup);
			process.on('SIGINT', () => {
				cleanup();
				process.exit(0);
			});
		}

		const server = await createServer();

		server.httpServer?.on('listening', async () => {
			const { address, port: vitePort } = server.httpServer!.address() as AddressInfo;
			const viteHost = address === '::1' ? 'localhost' : address;
			await fs.promises.mkdir(viteMetadataDir, { recursive: true });
			await fs.promises.writeFile(
				viteMetadataFile,
				JSON.stringify({
					pocketbaseUrl: process.env.POCKETBASE_URL,
					vitePort,
					viteHost
				})
			);

			const pb = new PocketBase(process.env.POCKETBASE_URL!);
			await pb
				.collection('_superusers')
				.authWithPassword(
					process.env.POCKETBASE_SUPERUSER_EMAIL!,
					process.env.POCKETBASE_SUPERUSER_PASSWORD!
				);
			await pb.settings.update({ meta: { appURL: `http://${viteHost}:${vitePort}` } });

			await startWatchingTypes(cwd);
		});

		await server.listen();

		const hasExistingLogs =
			process.stdout.bytesWritten > 0 || process.stderr.bytesWritten > 0;
		const startupDurationString = pc.dim(
			`ready in ${pc.reset(pc.bold(Math.ceil(performance.now() - startTime)))} ms`
		);
		server.config.logger.info(
			`\n  ${pc.green(`${pc.bold('VITE')} v${version}`)}  ${startupDurationString}\n`,
			{ clear: !hasExistingLogs }
		);
		server.printUrls();
		server.bindCLIShortcuts({ print: true });
	});

async function startWatchingTypes(cwd: string): Promise<void> {
	const { processTypes } = await import('@velastack/pocketbase/internal');

	const config = {
		pocketbaseUrl: process.env.POCKETBASE_URL!,
		superuserEmail: process.env.POCKETBASE_SUPERUSER_EMAIL!,
		superuserPassword: process.env.POCKETBASE_SUPERUSER_PASSWORD!
	};
	const typesDir = path.resolve(cwd, '.svelte-kit', 'types');
	const pocketbaseDir = path.join(typesDir, 'pocketbase');
	const pocketbaseTypes = path.join(pocketbaseDir, '$types.d.ts');

	await processTypes(config, typesDir);

	const watcher = fs.promises.watch(pocketbaseDir);
	(async () => {
		for await (const event of watcher) {
			if (
				event.eventType === 'rename' &&
				event.filename === '$types.d.ts' &&
				!fs.existsSync(pocketbaseTypes)
			) {
				setTimeout(() => {
					processTypes(config, typesDir).catch(() => {});
				}, 100);
			}
		}
	})();
}
