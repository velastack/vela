import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	TYPES_FILE,
	createRegenerator,
	legacyTypesDir,
	typesDir,
	watchPocketbaseTypes,
	writePocketbaseTypes
} from './pocketbase-types.ts';

let tmp: string;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vela-pb-types-')));
});

afterEach(() => {
	vi.useRealTimers();
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** What `processTypes` does, with the schema fetch counted. */
function fakeGenerate(content = 'export type Models = {};\n') {
	const generate = vi.fn(async (baseDir: string) => {
		const dir = path.join(baseDir, 'pocketbase');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `${TYPES_FILE}.tmp`), content);
		fs.renameSync(path.join(dir, `${TYPES_FILE}.tmp`), path.join(dir, TYPES_FILE));
	});
	return generate;
}

describe('writePocketbaseTypes', () => {
	test('writes both locations from one generation', async () => {
		const generate = fakeGenerate('export type Models = { songs: {} };\n');
		await writePocketbaseTypes(tmp, generate);

		expect(generate).toHaveBeenCalledOnce();
		expect(generate).toHaveBeenCalledWith(path.join(tmp, '.svelte-kit'));
		const current = path.join(tmp, '.svelte-kit', 'pocketbase', '$types.d.ts');
		const legacy = path.join(tmp, '.svelte-kit', 'types', 'pocketbase', '$types.d.ts');
		expect(fs.readFileSync(current, 'utf8')).toContain('songs');
		expect(fs.readFileSync(legacy, 'utf8')).toBe(fs.readFileSync(current, 'utf8'));
		expect(fs.readdirSync(path.dirname(legacy))).toEqual(['$types.d.ts']);
	});
});

describe('createRegenerator', () => {
	test('many requests close together run once', async () => {
		vi.useFakeTimers();
		const run = vi.fn(async () => {});
		const request = createRegenerator(run, 100);
		request();
		request();
		request();
		await vi.advanceTimersByTimeAsync(500);
		expect(run).toHaveBeenCalledOnce();
	});

	test('a request during a run is honoured by one more run, not a loop', async () => {
		vi.useFakeTimers();
		let finish = () => {};
		const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
		const request = createRegenerator(run, 100);
		request();
		await vi.advanceTimersByTimeAsync(100);
		expect(run).toHaveBeenCalledTimes(1);
		request();
		request();
		finish();
		await vi.advanceTimersByTimeAsync(100);
		expect(run).toHaveBeenCalledTimes(2);
		finish();
		await vi.advanceTimersByTimeAsync(1000);
		expect(run).toHaveBeenCalledTimes(2);
	});

	test('a failed run does not stop later ones', async () => {
		vi.useFakeTimers();
		const run = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined);
		const request = createRegenerator(run, 10);
		request();
		await vi.advanceTimersByTimeAsync(50);
		request();
		await vi.advanceTimersByTimeAsync(50);
		expect(run).toHaveBeenCalledTimes(2);
	});
});

describe('watchPocketbaseTypes', () => {
	const settle = (ms = 500) => new Promise((resolve) => setTimeout(resolve, ms));

	async function watching() {
		const generate = fakeGenerate();
		const regenerate = vi.fn(() => writePocketbaseTypes(tmp, generate));
		await regenerate();
		regenerate.mockClear();
		const stop = watchPocketbaseTypes(tmp, createRegenerator(regenerate, 50), 50);
		await settle(200);
		return { regenerate, stop };
	}
	const current = () => path.join(typesDir(tmp), TYPES_FILE);
	const legacy = () => path.join(legacyTypesDir(tmp), TYPES_FILE);

	test('regenerates once when the old-path copy is deleted, as SvelteKit does', async () => {
		const { regenerate, stop } = await watching();
		try {
			fs.unlinkSync(legacy());
			await settle();
			expect(regenerate).toHaveBeenCalledOnce();
			expect(fs.existsSync(legacy())).toBe(true);
			// Its own writes are not a reason to write again.
			await settle();
			expect(regenerate).toHaveBeenCalledOnce();
		} finally {
			stop();
		}
	});

	test('regenerates once when both copies are unlinked together', async () => {
		const { regenerate, stop } = await watching();
		try {
			fs.unlinkSync(legacy());
			fs.unlinkSync(current());
			await settle();
			expect(regenerate).toHaveBeenCalledOnce();
			expect(fs.existsSync(current())).toBe(true);
			expect(fs.existsSync(legacy())).toBe(true);
		} finally {
			stop();
		}
	});

	test('survives SvelteKit removing the whole old directory', async () => {
		const { regenerate, stop } = await watching();
		try {
			fs.rmSync(path.join(tmp, '.svelte-kit', 'types'), { recursive: true });
			await settle();
			expect(regenerate).toHaveBeenCalledOnce();
			expect(fs.existsSync(legacy())).toBe(true);

			fs.unlinkSync(legacy());
			await settle();
			expect(regenerate).toHaveBeenCalledTimes(2);
		} finally {
			stop();
		}
	});
});

describe('a regeneration that fails', () => {
	test('is not retried until a copy disappears again', async () => {
		const generate = vi.fn(async (baseDir: string) => {
			const dir = path.join(baseDir, 'pocketbase');
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, TYPES_FILE), '');
		});
		await writePocketbaseTypes(tmp, generate);
		const failing = vi.fn(async () => {
			throw new Error('PocketBase is down');
		});
		const stop = watchPocketbaseTypes(tmp, createRegenerator(failing, 20), 20);
		try {
			fs.unlinkSync(path.join(legacyTypesDir(tmp), TYPES_FILE));
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(failing).toHaveBeenCalledOnce();
		} finally {
			stop();
		}
	});
});
