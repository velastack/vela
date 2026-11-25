import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const errors: string[] = [];
vi.mock('@clack/prompts', () => ({
	log: { error: (text: string) => errors.push(text), message: () => {} },
	cancel: (text: string) => errors.push(text)
}));

const withPocketbase = vi.fn();
vi.mock('../lib/pocketbase.ts', async (original) => ({
	...(await original<typeof import('../lib/pocketbase.ts')>()),
	withPocketbase: (...args: unknown[]) => withPocketbase(...args)
}));

import { sync } from './sync.ts';

describe('vela sync', () => {
	let root: string;
	let cwd: string;
	let printed: string[];

	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vela-sync-')));
		fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
		fs.mkdirSync(path.join(root, 'src', 'routes'), { recursive: true });
		// What a fresh checkout has: the tracked parts of data/, and no database.
		fs.mkdirSync(path.join(root, 'data', 'hooks'), { recursive: true });
		cwd = process.cwd();
		process.chdir(root);
		errors.length = 0;
		printed = [];
		vi.spyOn(console, 'log').mockImplementation((line: string) => void printed.push(line));
		withPocketbase.mockReset();
	});

	afterEach(() => {
		process.chdir(cwd);
		process.exitCode = undefined;
		vi.restoreAllMocks();
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('with no database yet, says so in one line and succeeds', async () => {
		await sync.parseAsync([], { from: 'user' });
		expect(withPocketbase).not.toHaveBeenCalled();
		expect(printed).toHaveLength(1);
		expect(printed[0]).toContain('No local database yet: skipping type sync.');
		expect(errors).toEqual([]);
		expect(process.exitCode).toBeUndefined();
		expect(fs.existsSync(path.join(root, 'data', 'data.db'))).toBe(false);
	});

	test('with a database, wrong credentials are still an error', async () => {
		fs.writeFileSync(path.join(root, 'data', 'data.db'), '');
		withPocketbase.mockRejectedValue(
			new Error('Failed to authenticate with PocketBase. Check your superuser credentials.')
		);
		await sync.parseAsync([], { from: 'user' });
		expect(withPocketbase).toHaveBeenCalledOnce();
		expect(errors.join('\n')).toContain('Failed to sync types. Failed to authenticate');
		expect(process.exitCode).toBe(1);
	});

	test('a running dev server is reached even before its database is on disk here', async () => {
		fs.mkdirSync(path.join(root, 'node_modules', '.vite'), { recursive: true });
		fs.writeFileSync(
			path.join(root, 'node_modules', '.vite', '_pocketbase_metadata.json'),
			JSON.stringify({
				pocketbaseUrl: 'http://localhost:8090',
				vitePort: 5173,
				viteHost: 'localhost'
			})
		);
		withPocketbase.mockResolvedValue(undefined);
		await sync.parseAsync([], { from: 'user' });
		expect(withPocketbase).toHaveBeenCalledOnce();
		expect(printed).toEqual(['types synced']);
	});
});
