import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * Where the generated PocketBase types live.
 *
 * They used to sit under `.svelte-kit/types`, which SvelteKit owns: every Vite
 * server with its plugin (vitest, `svelte-kit sync`, a build) deletes what it
 * did not write there, so a test run took `Models[...]` away until the next
 * `vela sync`. `.svelte-kit/pocketbase` is outside what Kit cleans (`types`
 * and `output`).
 *
 * Both are written for now. A project that has upgraded vela but not its
 * tsconfig, or not `@velastack/pocketbase`, still reads the old one.
 */
export const TYPES_FILE = '$types.d.ts';

/** The directory handed to `processTypes`, which writes `<dir>/pocketbase/$types.d.ts`. */
export function typesBaseDir(root: string): string {
	return path.join(root, '.svelte-kit');
}

export function typesDir(root: string): string {
	return path.join(typesBaseDir(root), 'pocketbase');
}

export function legacyTypesDir(root: string): string {
	return path.join(typesBaseDir(root), 'types', 'pocketbase');
}

/** The tsconfig `include` entries for the two locations. */
export const TYPES_INCLUDE = '.svelte-kit/pocketbase/*.d.ts';
export const LEGACY_TYPES_INCLUDE = '.svelte-kit/types/pocketbase/*.d.ts';

/**
 * Generate the types once and put them at both locations. `generate` is
 * `processTypes` bound to a client: one fetch of the schema, then a copy.
 */
export async function writePocketbaseTypes(
	root: string,
	generate: (baseDir: string) => Promise<unknown>
): Promise<void> {
	await generate(typesBaseDir(root));

	const source = path.join(typesDir(root), TYPES_FILE);
	const legacy = path.join(legacyTypesDir(root), TYPES_FILE);
	await fs.promises.mkdir(path.dirname(legacy), { recursive: true });
	// Renamed into place, as `processTypes` does, so a reader never sees half a file.
	const tmp = `${legacy}.${process.pid}.tmp`;
	await fs.promises.copyFile(source, tmp);
	await fs.promises.rename(tmp, legacy);
}

/**
 * A regeneration that can be asked for many times and runs once: both copies
 * vanishing together (the middleware's "schema changed" signal) is one
 * request, and a request that arrives while one is running is honoured by a
 * single run afterwards. A failed run is dropped; the next request tries again.
 */
export function createRegenerator(run: () => Promise<void>, delayMs = 100): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running = false;
	let queued = false;

	const request = () => {
		if (running) {
			queued = true;
			return;
		}
		if (timer) return;
		timer = setTimeout(fire, delayMs);
	};
	const fire = async () => {
		timer = undefined;
		running = true;
		try {
			await run();
		} catch {
			// PocketBase is restarting, or gone; the types stay as they are.
		} finally {
			running = false;
			if (queued) {
				queued = false;
				request();
			}
		}
	};
	return request;
}

/**
 * Watch both type locations and call `onMissing` when either copy disappears.
 *
 * `@velastack/pocketbase` unlinks the file (the old path, or both) to say the
 * schema changed, and SvelteKit deletes the old-path copy, directory and all,
 * whenever it rewrites its manifest. Either way the answer is to write them
 * again.
 *
 * The two paths are checked a few times a second rather than watched with
 * `fs.watch`: a watch is bound to its directory's inode, and reports nothing
 * at all when a parent of that directory is removed, which is exactly what
 * SvelteKit does. Only a copy going from present to missing counts, so a
 * regeneration that fails (PocketBase is down) is not retried until something
 * changes again, and writing the files back can never trigger another write.
 * Returns a function that stops watching.
 */
export function watchPocketbaseTypes(
	root: string,
	onMissing: () => void,
	intervalMs = 250
): () => void {
	const files = [
		path.join(typesDir(root), TYPES_FILE),
		path.join(legacyTypesDir(root), TYPES_FILE)
	];
	const present = files.map((file) => fs.existsSync(file));

	const timer = setInterval(() => {
		let vanished = false;
		files.forEach((file, index) => {
			const exists = fs.existsSync(file);
			if (present[index] && !exists) vanished = true;
			present[index] = exists;
		});
		if (vanished) onMissing();
	}, intervalMs);
	// The dev server keeps the process alive, not this.
	timer.unref();
	return () => clearInterval(timer);
}
