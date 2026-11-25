import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import PocketBase from 'pocketbase';
import { x } from 'tinyexec';
import { DATA_DIR, MIGRATIONS_DIR } from './constants.ts';

/**
 * The PocketBase executable that ships with vela, as an absolute path.
 *
 * `pocketbase-server` is vela's dependency, not the project's, so this is the
 * only place it can be found reliably: `npx pocketbase-server` works when the
 * project's node_modules happens to hoist it and exits 127 when it does not,
 * and `pnpm dlx` downloads some other version. Each platform's binary is an
 * optional dependency of `pocketbase-server`, resolved from there.
 *
 * `pocketbase-server`'s own `getBinaryPath()` ends the process when that
 * package is missing; this throws something a command can report instead.
 * The arguments are for tests.
 */
export function pocketbaseBinaryPath(
	platform: string = process.platform,
	arch: string = process.arch
): string {
	const key = `${platform}-${arch}`;
	const binary = platform === 'win32' ? 'pocketbase.exe' : 'pocketbase';
	try {
		const require = createRequire(import.meta.url);
		const fromServer = createRequire(require.resolve('pocketbase-server/package.json'));
		return fromServer.resolve(`pocketbase-server-${key}/bin/${binary}`);
	} catch {
		throw new Error(
			`The PocketBase binary for ${key} is not installed.\n\n` +
				`It comes with vela as an optional dependency (pocketbase-server-${key}), which an install\n` +
				`with --omit=optional or --no-optional, or one copied from another platform, leaves out.\n` +
				`Reinstall the project's dependencies (remove node_modules and install again).`
		);
	}
}

/**
 * Tell the code vela runs in-process where that binary is.
 *
 * `@velastack/patterns` reads `VELA_POCKETBASE_BIN` and spawns it directly
 * rather than going through `npx pocketbase-server`, for the reasons above. A
 * value that is already set is the user's and is kept. A binary that cannot be
 * found leaves the variable unset: most patterns never start PocketBase, and
 * the ones that do then report it themselves.
 */
export function exposePocketbaseBinary(
	env: NodeJS.ProcessEnv = process.env,
	resolve: () => string = pocketbaseBinaryPath
): void {
	if (env.VELA_POCKETBASE_BIN) return;
	try {
		env.VELA_POCKETBASE_BIN = resolve();
	} catch {
		// Left unset.
	}
}

/**
 * The first free port at or after `start`, probed the way vite does before it
 * listens. Used to know the dev server's port before anything that needs it
 * (PocketBase's `ORIGIN`) is started, by then passing the answer to vite with
 * `strictPort`.
 */
export async function firstFreePort(start: number, host = 'localhost'): Promise<number> {
	for (let port = start; port < start + 100; port++) {
		if (await portIsFree(port, host)) return port;
	}
	throw new Error(`No free port between ${start} and ${start + 99} on ${host}`);
}

function portIsFree(port: number, host: string): Promise<boolean> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.unref();
		server.once('error', () => resolve(false));
		server.listen(port, host, () => server.close(() => resolve(true)));
	});
}

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
	/** Extra variables for the PocketBase process, on top of this one's. */
	env?: Record<string, string>;
}

export async function startPocketbaseServe(opts: StartPocketbaseServeOptions): Promise<{
	proc: ChildProcess;
	port: number;
	url: string;
}> {
	const binaryPath = pocketbaseBinaryPath();
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
		const proc = spawn(binaryPath, args, {
			stdio,
			...(opts.env ? { env: { ...process.env, ...opts.env } } : {})
		});

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
): { pocketbaseUrl: string; vitePort: number; viteHost: string } | null {
	const metadataPath = path.join(cwd, 'node_modules', '.vite', '_pocketbase_metadata.json');
	if (fs.existsSync(metadataPath)) {
		return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
	}
	return null;
}

/**
 * Whether there is a local database to talk to: one on disk, or one a running
 * `vela dev` has recorded the address of.
 *
 * A fresh checkout has neither. `data/` itself is there (hooks and seeds are
 * tracked) but `data/data.db` is not, and starting PocketBase on it would only
 * create an empty database with no superuser to sign in as.
 */
export function hasLocalDatabase(cwd: string): boolean {
	if (fs.existsSync(path.join(cwd, DATA_DIR, 'data.db'))) return true;
	return Boolean(getPocketbaseMetadata(cwd)?.pocketbaseUrl);
}

/**
 * Run the PocketBase binary once and wait for it. Throws when it exits
 * non-zero, quoting the command.
 */
function runPocketbase(cwd: string, args: string[], stdio: 'inherit' | 'pipe' = 'pipe') {
	return x(pocketbaseBinaryPath(), args, { nodeOptions: { cwd, stdio }, throwOnError: true });
}

/**
 * Run one piece of work against the local database, authenticated.
 *
 * Uses the server `vela dev` has running when there is one, and otherwise
 * starts one for the duration. That one loads the app's hooks only when asked:
 * a command writing the app's own data wants them to apply as they would to any
 * write, and one inspecting or migrating the database does not want them in
 * the way.
 */
export async function withPocketbase(
	cwd: string,
	fn: (pb: PocketBase) => Promise<void>,
	creds?: { email: string; password: string },
	opts: { hooks?: boolean } = {}
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

	const hooksDir = path.join(dir, 'hooks');
	const { proc, url } = await startPocketbaseServe({
		dataDir: dir,
		migrationsDir,
		...(opts.hooks && fs.existsSync(hooksDir) ? { hooksDir } : {}),
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

async function runSuperuserCommand(
	cwd: string,
	action: 'create' | 'upsert',
	email: string,
	password: string
): Promise<void> {
	const dir = path.join(cwd, DATA_DIR);
	const migrationsDir = path.join(cwd, MIGRATIONS_DIR);
	fs.mkdirSync(dir, { recursive: true });
	fs.mkdirSync(migrationsDir, { recursive: true });

	try {
		await runPocketbase(
			cwd,
			['--dir', dir, '--migrationsDir', migrationsDir, 'superuser', action, email, password],
			'pipe'
		);
	} catch (e) {
		// tinyexec reports a failure by quoting the whole command, and the last
		// argument of this one is the superuser's password. Rethrown without it:
		// the message reaches terminals and CI logs, neither of which should end
		// up holding the credential.
		const detail = e instanceof Error ? e.message.replaceAll(password, '<password>') : '';
		throw new Error(
			`PocketBase could not ${action} the superuser ${email}.${detail ? `\n\n${detail}` : ''}`
		);
	}
}

export function createSuperuser(cwd: string, email: string, password: string): Promise<void> {
	return runSuperuserCommand(cwd, 'create', email, password);
}

/**
 * Create the superuser, or reset its password when the account is already there.
 *
 * `createSuperuser` fails on an email the database already knows, which is right
 * for `vela create` and `vela bless` — both start from a directory with no
 * database in it. `vela enable backend` can run in a project whose `data/`
 * survived a `vela disable backend`, or whose `.env` already names a superuser,
 * and upserting is what keeps the two from disagreeing.
 */
export function upsertSuperuser(cwd: string, email: string, password: string): Promise<void> {
	return runSuperuserCommand(cwd, 'upsert', email, password);
}

export async function launchPocketbase(
	cwd: string,
	{
		dir,
		migrationsDir,
		hooksDir,
		email,
		password
	}: { dir: string; migrationsDir: string; hooksDir?: string; email: string; password: string }
) {
	const host = 'localhost';
	fs.mkdirSync(dir, { recursive: true });
	fs.mkdirSync(migrationsDir, { recursive: true });

	await runPocketbase(
		cwd,
		['--dir', dir, '--migrationsDir', migrationsDir, 'superuser', 'create', email, password],
		'pipe'
	);

	await runPocketbase(
		cwd,
		['--dir', dir, '--migrationsDir', migrationsDir, 'migrate', 'up'],
		'inherit'
	);

	const { proc, url } = await startPocketbaseServe({
		dataDir: dir,
		migrationsDir,
		hooksDir,
		host,
		stdio: 'pipe'
	});
	const output = drainOutput(proc);

	return {
		stop: () => proc.kill(),
		url,
		/** The last of what PocketBase printed, for a failure report. */
		output
	};
}

/** How much of a piped process's output `drainOutput` keeps. */
const OUTPUT_TAIL_BYTES = 64 * 1024;

/**
 * Keep reading a child's piped stdout and stderr, and return a function that
 * gives the last of it.
 *
 * A pipe nobody reads fills up (64 KB on Linux), and the child then blocks on
 * its next write. PocketBase writes a line for every mail it cannot send and
 * every error it logs, so a test run that produced enough of them froze the
 * database part-way through: every request after that hung until the test
 * timed out.
 */
export function drainOutput(proc: ChildProcess): () => string {
	let tail = '';
	const keep = (chunk: Buffer | string) => {
		tail = (tail + chunk.toString()).slice(-OUTPUT_TAIL_BYTES);
	};
	proc.stdout?.on('data', keep);
	proc.stderr?.on('data', keep);
	return () => tail;
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

/**
 * Make sure the configured superuser exists in the local database.
 *
 * A vela app authenticates as its superuser while rendering, so a build needs
 * one to exist. On a developer's machine it always does; on a fresh checkout —
 * CI, a new clone, a wiped `data/` — the database is empty and the build fails
 * at prerendering with "invalid login credentials". `upsert` is idempotent, so
 * this is a no-op everywhere else.
 */
export async function ensureSuperuser(cwd: string): Promise<void> {
	const email = process.env.POCKETBASE_SUPERUSER_EMAIL;
	const password = process.env.POCKETBASE_SUPERUSER_PASSWORD;
	if (!email || !password) return;

	const dir = path.join(cwd, DATA_DIR);
	if (!fs.existsSync(dir)) return;

	await x(
		pocketbaseBinaryPath(),
		[
			'--dir',
			dir,
			'--migrationsDir',
			path.join(cwd, MIGRATIONS_DIR),
			'superuser',
			'upsert',
			email,
			password
		],
		{ nodeOptions: { cwd, stdio: 'ignore' } }
	);
}
