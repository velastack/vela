/**
 * Vitest support for vela projects.
 *
 * The default export is a vitest global setup: it starts the servers the
 * server tests need (a throwaway PocketBase with the app's hooks, seeds and
 * fixtures, and the app under Vite in test mode) before the first test file
 * runs, and stops them after the last. A project names it in
 * `vitest.config.ts`:
 *
 * ```ts
 * test: { globalSetup: ['vela/testing'] }
 * ```
 *
 * The servers run in a child process (`vela test:harness`), so vitest, bare
 * or through `vela test:server`, in watch mode or from an editor, boots the
 * same thing. Tests reach the servers through `inject('vela')`, and through
 * the environment `vela test:server` always set: `POCKETBASE_URL`,
 * `POCKETBASE_SUPERUSER_EMAIL`, `POCKETBASE_SUPERUSER_PASSWORD`,
 * `VELA_DATA_DIR`, `VITE_TEST_URL` and `TEST=true`.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

/** What a server-test run talks to; `inject('vela')` in a test or setup file. */
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

declare module 'vitest' {
	interface ProvidedContext {
		vela: TestServers;
	}
}

type HarnessMessage =
	| { type: 'ready'; servers: TestServers; env: Record<string, string> }
	| { type: 'error'; message: string };

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
	// This package's own bin, so the harness is the vela the project installed,
	// whatever is on the PATH.
	const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
	const child = spawn(process.execPath, [bin, 'test:harness'], {
		cwd: project.config.root,
		// `test.env` from the config reaches the app too, not only the workers,
		// so a suite's settings live in one place.
		env: { ...process.env, ...project.config.env },
		stdio: ['ignore', 'inherit', 'inherit', 'ipc']
	});
	const exited = new Promise<number | null>((resolve) => {
		child.once('exit', (code) => resolve(code));
	});

	const ready = await new Promise<Extract<HarnessMessage, { type: 'ready' }>>((resolve, reject) => {
		child.on('message', (message: HarnessMessage) => {
			if (message.type === 'ready') resolve(message);
			else reject(new Error(message.message));
		});
		void exited.then((code) =>
			reject(new Error(`vela test:harness exited with code ${code} before its servers were up`))
		);
	});

	// Workers start after this returns and inherit the environment, so the
	// setup file and the tests see the same variables `vela test:server` set.
	Object.assign(process.env, ready.env);
	project.provide('vela', ready.servers);

	return async () => {
		if (child.exitCode !== null) return;
		child.send('stop');
		const timer = setTimeout(() => child.kill(), 5_000);
		await exited;
		clearTimeout(timer);
	};
}
