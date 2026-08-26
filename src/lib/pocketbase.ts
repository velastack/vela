import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import PocketBase from 'pocketbase';
import { detect } from 'package-manager-detector';
import { resolveCommand } from 'package-manager-detector/commands';
import { x } from 'tinyexec';
import { DATA_DIR, MIGRATIONS_DIR } from './constants.ts';

export function findFreePort(host = 'localhost'): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.once('error', reject);
		server.listen(0, host, () => {
			const addr = server.address() as net.AddressInfo | null;
			server.close((err) => {
				if (err) reject(err);
				else if (!addr) reject(new Error('Failed to obtain a free port'));
				else resolve(addr.port);
			});
		});
	});
}

function waitForReadyOrExit(proc: ChildProcess, url: string, maxAttempts = 40): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			if (settled) return;
			settled = true;
			reject(
				new Error(`PocketBase exited before becoming healthy (code=${code}, signal=${signal})`)
			);
		};
		proc.once('exit', onExit);

		let attempts = 0;
		const check = async () => {
			if (settled) return;
			attempts++;
			try {
				const r = await fetch(`${url}/api/health`);
				if (r.status === 200) {
					if (settled) return;
					settled = true;
					proc.removeListener('exit', onExit);
					resolve();
					return;
				}
			} catch {
				/* retry */
			}
			if (attempts >= maxAttempts) {
				if (settled) return;
				settled = true;
				proc.removeListener('exit', onExit);
				reject(new Error(`Timed out waiting for health at ${url}`));
				return;
			}
			setTimeout(check, 250);
		};
		check();
	});
}

export interface StartPocketbaseServeOptions {
	dataDir: string;
	migrationsDir: string;
	hooksDir?: string;
	dev?: boolean;
	stdio?: 'inherit' | 'pipe' | 'ignore';
	host?: string;
	maxAttempts?: number;
}

export async function startPocketbaseServe(opts: StartPocketbaseServeOptions): Promise<{
	proc: ChildProcess;
	port: number;
	url: string;
}> {
	const { getBinaryPath } = await import('pocketbase-server');
	const binaryPath = getBinaryPath();
	const host = opts.host ?? 'localhost';
	const stdio = opts.stdio ?? 'inherit';
	const maxAttempts = opts.maxAttempts ?? 5;

	let lastErr: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const port = await findFreePort(host);
		const args = [
			'serve',
			'--dir',
			opts.dataDir,
			'--migrationsDir',
			opts.migrationsDir,
			...(opts.hooksDir ? ['--hooksDir', opts.hooksDir] : []),
			...(opts.dev ? ['--dev'] : []),
			'--http',
			`${host}:${port}`
		];
		const proc = spawn(binaryPath, args, { stdio });

		try {
			await waitForReadyOrExit(proc, `http://${host}:${port}`);
			return { proc, port, url: `http://${host}:${port}` };
		} catch (err) {
			lastErr = err;
			if (proc.exitCode === null && proc.signalCode === null) {
				await new Promise<void>((resolve) => {
					proc.once('exit', () => resolve());
					proc.kill();
				});
			}
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error('Failed to start PocketBase');
}

export async function authWithRetries(
	pb: PocketBase,
	email: string,
	password: string,
	attempts = 3
) {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			await pb.collection('_superusers').authWithPassword(email, password);
			return;
		} catch (e) {
			if (attempt === attempts) {
				throw new Error(
					'Failed to authenticate with PocketBase. Check your superuser credentials.'
				);
			}
			await new Promise((r) => setTimeout(r, 100));
		}
	}
}

export function getPocketbaseMetadata(
	cwd: string
): { pocketbaseUrl: string; vitePort: number } | null {
	const metadataPath = path.join(cwd, 'node_modules', '.vite', '_pocketbase_metadata.json');
	if (fs.existsSync(metadataPath)) {
		return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
	}
	return null;
}

async function execPackageBin(cwd: string, args: string[], stdio: 'inherit' | 'pipe' = 'pipe') {
	const packageManager = (await detect({ cwd }))?.name ?? 'npm';
	const resolved = resolveCommand(packageManager, 'execute', args);
	if (!resolved) throw new Error(`Could not resolve command for ${packageManager}`);
	const { command, args: resolvedArgs } = resolved;
	if (packageManager === 'npm') resolvedArgs.unshift('--yes');
	return x(command, resolvedArgs, { nodeOptions: { cwd, stdio }, throwOnError: true });
}

export async function withPocketbase(
	cwd: string,
	fn: (pb: PocketBase) => Promise<void>,
	creds?: { email: string; password: string }
) {
	const dir = path.join(cwd, DATA_DIR);
	const migrationsDir = path.join(cwd, MIGRATIONS_DIR);
	const host = 'localhost';
	const email = creds?.email ?? process.env.POCKETBASE_SUPERUSER_EMAIL!;
	const password = creds?.password ?? process.env.POCKETBASE_SUPERUSER_PASSWORD!;

	if (!fs.existsSync(dir)) {
		throw new Error('PocketBase data directory does not exist');
	}

	const metadata = getPocketbaseMetadata(cwd);
	if (metadata?.pocketbaseUrl) {
		const pb = new PocketBase(metadata.pocketbaseUrl);
		await authWithRetries(pb, email, password);
		await fn(pb);
		return;
	}

	const { proc, url } = await startPocketbaseServe({
		dataDir: dir,
		migrationsDir,
		host,
		stdio: 'ignore'
	});

	try {
		const pb = new PocketBase(url);
		await authWithRetries(pb, email, password);
		await fn(pb);
	} finally {
		proc.kill();
	}
}

export async function createSuperuser(cwd: string, email: string, password: string): Promise<void> {
	const dir = path.join(cwd, DATA_DIR);
	const migrationsDir = path.join(cwd, MIGRATIONS_DIR);
	fs.mkdirSync(dir, { recursive: true });
	fs.mkdirSync(migrationsDir, { recursive: true });

	await execPackageBin(
		cwd,
		[
			'pocketbase-server',
			'--dir',
			dir,
			'--migrationsDir',
			migrationsDir,
			'superuser',
			'create',
			email,
			password
		],
		'pipe'
	);
}

export async function launchPocketbase(
	cwd: string,
	{
		dir,
		migrationsDir,
		email,
		password
	}: { dir: string; migrationsDir: string; email: string; password: string }
) {
	const host = 'localhost';
	fs.mkdirSync(dir, { recursive: true });
	fs.mkdirSync(migrationsDir, { recursive: true });

	await execPackageBin(
		cwd,
		[
			'pocketbase-server',
			'--dir',
			dir,
			'--migrationsDir',
			migrationsDir,
			'superuser',
			'create',
			email,
			password
		],
		'pipe'
	);

	await execPackageBin(
		cwd,
		['pocketbase-server', '--dir', dir, '--migrationsDir', migrationsDir, 'migrate', 'up'],
		'inherit'
	);

	const { proc, url } = await startPocketbaseServe({
		dataDir: dir,
		migrationsDir,
		host,
		stdio: 'pipe'
	});

	return {
		stop: () => proc.kill(),
		url
	};
}

/**
 * The PocketBase version this CLI develops against.
 *
 * Servers install the same build, so a deployed app and a developer's machine
 * never differ on the database engine.
 */
export function pocketbaseVersion(): string {
	const require = createRequire(import.meta.url);
	const pkg = require('pocketbase-server/package.json') as { version: string };
	return pkg.version;
}
