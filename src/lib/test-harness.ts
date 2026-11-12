import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import PocketBase from 'pocketbase';
import type { Plugin, ViteDevServer } from 'vite';
import { authWithRetries, findFreePort, launchPocketbase } from './pocketbase.ts';
import { DATA_DIR, MIGRATIONS_DIR } from './constants.ts';
import { DataLoadError, loadFixtures, loadSeeds } from './data.ts';
import { loadVite } from './vite.ts';

/** The directory under the project that holds every run's throwaway data. */
export const TEST_DATA_DIR = 'test-data';

/**
 * What a server-test run talks to. The same shape reaches the tests through
 * vitest's `inject('vela')`.
 */
export interface TestServers {
	/** The throwaway PocketBase, migrated and loaded with seeds and fixtures. */
	pocketbaseUrl: string;
	/** The app, served by Vite in test mode with its pages stubbed out. */
	appUrl: string;
	/** The superuser the harness created in the throwaway database. */
	superuser: { email: string; password: string };
	/** The run's data directory: PocketBase's, uploads, the CMS database. */
	dataDir: string;
}

export interface TestHarness extends TestServers {
	/** The variables the app and the tests read, as `vela test:server` always set them. */
	env: Record<string, string>;
	/** Stop both servers and remove the data directory. */
	stop(): Promise<void>;
	/**
	 * The synchronous part of `stop`, for exit and signal handlers: kills
	 * PocketBase and removes the data directory. Vite is left to the process
	 * exit.
	 */
	stopSync(): void;
}

export class HarnessError extends Error {}

/**
 * Start the servers a server-test run needs, in this process: a throwaway
 * PocketBase with the app's hooks, migrated and loaded with seeds and
 * fixtures, and the app under Vite in test mode. Sets the environment the app
 * reads before Vite starts, so the app sees the throwaway database and
 * `TEST=true`.
 *
 * Each run gets its own directory under `test-data/`, named after the
 * process, so an editor's test runner and a terminal run do not share a
 * database. Directories left by runs that died without cleaning up are
 * removed on the way in.
 */
export async function startTestHarness(
	cwd: string,
	{ log = () => {} }: { log?: (message: string) => void } = {}
): Promise<TestHarness> {
	const email = `test-${Math.random().toString(36).slice(2)}@example.com`;
	const password = 'password';

	const root = path.join(cwd, TEST_DATA_DIR);
	pruneStaleRuns(root);
	const dataDir = path.join(root, String(process.pid));
	fs.rmSync(dataDir, { recursive: true, force: true });

	const { stop: stopPocketbase, url: pocketbaseUrl } = await launchPocketbase(cwd, {
		dir: dataDir,
		migrationsDir: path.join(cwd, MIGRATIONS_DIR),
		// The app's PocketBase hooks (slug generation, personal teams, …) are part
		// of its behaviour; the suite runs against the same server dev and build
		// start, so it loads them from the same place.
		hooksDir: path.join(cwd, DATA_DIR, 'hooks'),
		email,
		password
	});

	let vite: ViteDevServer | undefined;
	let stopped = false;
	const stopSync = () => {
		if (stopped) return;
		stopped = true;
		stopPocketbase();
		fs.rmSync(dataDir, { recursive: true, force: true });
	};
	const stop = async () => {
		if (stopped) return;
		// The app's workflow worker runs inside this Vite server and stops on
		// the event adapter-node emits in production; PocketBase is still up
		// at this point, so it drains cleanly instead of erroring every poll.
		process.emit('sveltekit:shutdown' as 'exit', 0);
		await vite?.close().catch(() => {});
		stopSync();
	};
	const fail = async (message: string): Promise<never> => {
		await stop();
		throw new HarnessError(message);
	};

	const env: Record<string, string> = {
		POCKETBASE_URL: pocketbaseUrl,
		POCKETBASE_SUPERUSER_EMAIL: email,
		POCKETBASE_SUPERUSER_PASSWORD: password,
		// The app's data directory is PocketBase's, here as everywhere else. It
		// points at the throwaway one so that a database or an uploaded file the
		// suite creates is removed with it, rather than accumulating in the
		// directory the developer actually works against.
		VELA_DATA_DIR: dataDir,
		TEST: 'true'
	};
	Object.assign(process.env, env);
	log('Created test database');

	const pb = new PocketBase(pocketbaseUrl);
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
		if (seeds.length > 0) log(`Loaded ${seeds.length} seed file(s)`);
		const fixtures = await loadFixtures(pb, cwd);
		if (fixtures.length > 0) log(`Loaded ${fixtures.length} fixture file(s)`);
	} catch (e) {
		await fail(describeLoadFailure(e));
	}

	try {
		const { createServer } = await loadVite(cwd);
		vite = await createServer({
			mode: 'test',
			plugins: [stubPagesPlugin()],
			optimizeDeps: { noDiscovery: true },
			// This config differs from `vela dev`'s, so sharing node_modules/.vite
			// would make Vite re-optimize dependencies under a running dev server,
			// which then loads two copies of Svelte and fails reading `page`.
			cacheDir: 'node_modules/.vite-test'
		});
		const port = await findFreePort();
		await vite.listen(port);
	} catch (e) {
		await fail(`Failed to start Vite: ${(e as Error).message}`);
	}
	const appUrl = `http://localhost:${vite!.config.server.port}`;
	env.VITE_TEST_URL = appUrl;
	process.env.VITE_TEST_URL = appUrl;

	log(`Started Vite: ${appUrl}`);
	log(`Started PocketBase: ${pocketbaseUrl}`);

	return {
		pocketbaseUrl,
		appUrl,
		superuser: { email, password },
		dataDir,
		env,
		stop,
		stopSync
	};
}

/**
 * Remove the run directories of harness processes that are no longer alive.
 * A run that was killed hard, or an editor that crashed, leaves its directory
 * behind; the next run sweeps it so `test-data/` does not grow forever.
 */
function pruneStaleRuns(root: string): void {
	if (!fs.existsSync(root)) return;
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const pid = Number(entry.name);
		if (!Number.isInteger(pid) || pid === process.pid) continue;
		if (isAlive(pid)) continue;
		fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM is a live process owned by someone else.
		return (e as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function describeLoadFailure(e: unknown): string {
	if (e instanceof DataLoadError) {
		const hint = e.malformed
			? `Fix ${e.file}, or rewrite it from a database with \`vela seeds save --force\`.`
			: e.kind === 'fixtures'
				? 'Run `vela fixtures regen` to regenerate fixtures from the current schema.'
				: `Check ${e.file} against the current schema.`;
		return `Failed to load ${e.message}\n  ${hint}`;
	}
	return `Failed to load test data: ${(e as Error).message}`;
}

/**
 * Server tests exercise endpoints and actions, so pages render nothing. A
 * layout stub still renders its children: SvelteKit 3 warns
 * (`layout_children_missing`) about a layout that does not, once per layout.
 */
function stubPagesPlugin(): Plugin {
	const stub = `<script>export const render = () => '';</script>`;
	const layoutStub = `<script>let { children } = $props(); export const render = () => '';</script>{@render children?.()}`;
	// `+page@.svelte` and `+layout@(app).svelte` reset the layout they sit
	// under and are a page and a layout like any other.
	const isPage = (id: string) => /\+page(@[^/]*)?\.svelte$/.test(id);
	const isLayout = (id: string) => /\+layout(@[^/]*)?\.svelte$/.test(id);
	return {
		name: 'stub-pages',
		resolveId(id: string) {
			if (isPage(id)) return id;
			return undefined;
		},
		load(id: string) {
			if (isLayout(id)) return layoutStub;
			if (isPage(id) || id.endsWith('+error.svelte')) return stub;
			return undefined;
		}
	};
}
