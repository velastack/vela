import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { Command, InvalidArgumentError } from 'commander';
import type { InlineConfig } from 'vite';
import pc from 'picocolors';
import PocketBase from 'pocketbase';
import { helpConfig } from '../lib/help.ts';
import { DATA_DIR, MIGRATIONS_DIR } from '../lib/constants.ts';
import { startPocketbaseServe } from '../lib/pocketbase.ts';
import { hasBackend } from '../lib/workspace.ts';
import { loadVite } from '../lib/vite.ts';

/**
 * Vite dev-server flags worth forwarding, spelled exactly as vite's own CLI
 * spells them so anything learned there carries over. `--open` is the one
 * `vela create` tells users to run.
 */
interface DevOptions {
	open?: boolean | string;
	host?: boolean | string;
	port?: number;
	cors?: boolean;
	strictPort?: boolean;
	force?: boolean;
}

/** Everything except `--force`, which vite routes outside `server`. */
type ServerFlags = Omit<DevOptions, 'force'>;

function parsePort(value: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new InvalidArgumentError('must be a whole number between 1 and 65535.');
	}
	return port;
}

export const dev = new Command('dev')
	.description('start the development server')
	.option('--open [path]', 'open the app in a browser once the server is ready')
	.option('--host [host]', 'expose the server on the network')
	.option('--port <port>', 'port to listen on', parsePort)
	.option('--strictPort', 'exit if the port is already in use instead of taking the next one')
	.option('--cors', 'enable CORS')
	.option('--force', 're-bundle dependencies, ignoring the optimizer cache')
	.configureHelp(helpConfig)
	.action(async (options: DevOptions) => {
		const cwd = process.cwd();
		const startTime = performance.now();

		const { createServer, version } = await loadVite(cwd);

		const viteMetadataDir = path.join(cwd, 'node_modules', '.vite');
		const viteMetadataFile = path.join(viteMetadataDir, '_pocketbase_metadata.json');

		let pbProc: ChildProcess | undefined;
		// A static project has no PocketBase to start, and nothing to sync types from.
		const backend = hasBackend(cwd);
		const needsStart = backend && !process.env.POCKETBASE_URL;

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

		// Only forward what was actually passed: an explicit `undefined` here would
		// still be merged over whatever vite.config.ts sets.
		const serverOptions: ServerFlags = {};
		if (options.open !== undefined) serverOptions.open = options.open;
		if (options.host !== undefined) serverOptions.host = options.host;
		if (options.port !== undefined) serverOptions.port = options.port;
		if (options.cors !== undefined) serverOptions.cors = options.cors;
		if (options.strictPort !== undefined) serverOptions.strictPort = options.strictPort;

		// `--force` is not a server option: vite's CLI strips it from the server
		// config and passes it as `forceOptimizeDeps`. Typed as vite's own
		// `InlineConfig` so a renamed or dropped option fails `lint:ts` here
		// rather than being silently ignored at runtime.
		const inlineConfig: InlineConfig = {
			server: serverOptions
		};
		if (options.force !== undefined) inlineConfig.forceOptimizeDeps = options.force;

		const server = await createServer(inlineConfig);

		server.httpServer?.on('listening', async () => {
			if (!backend) return;

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

			await startWatchingTypes(cwd, pb);
		});

		await server.listen();

		const hasExistingLogs = process.stdout.bytesWritten > 0 || process.stderr.bytesWritten > 0;
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

async function startWatchingTypes(cwd: string, pb: PocketBase): Promise<void> {
	const { processTypes } = await import('@velastack/pocketbase-codegen');

	const typesDir = path.resolve(cwd, '.svelte-kit', 'types');
	const pocketbaseDir = path.join(typesDir, 'pocketbase');
	const pocketbaseTypes = path.join(pocketbaseDir, '$types.d.ts');

	const regenerate = () => processTypes(pb, typesDir).catch(() => {});

	// Never let a first-run failure escape: this runs inside an async
	// `listening` listener, where a rejection takes the process down, and it
	// would also leave the session with no watcher at all. Both SvelteKit and
	// handlePocketbase rely on that watcher to rebuild $types.d.ts after they
	// delete it, so losing it silently disables type sync for the session.
	await regenerate();

	// Re-arm on failure: the watch is bound to the directory's inode, so
	// `rm -rf .svelte-kit` would otherwise kill it permanently.
	void (async () => {
		for (;;) {
			try {
				await fs.promises.mkdir(pocketbaseDir, { recursive: true });
				for await (const event of fs.promises.watch(pocketbaseDir)) {
					if (
						event.eventType === 'rename' &&
						event.filename === '$types.d.ts' &&
						!fs.existsSync(pocketbaseTypes)
					) {
						setTimeout(regenerate, 100);
					}
				}
			} catch {
				// directory vanished or the watch broke — rebuild and re-watch
				await new Promise((r) => setTimeout(r, 200));
			}
		}
	})();
}
