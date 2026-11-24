import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createSuperuser, pocketbaseBinaryPath, upsertSuperuser } from './pocketbase.ts';

describe('the PocketBase binary', () => {
	test("is resolved from vela's own dependency, as an absolute path to a file", () => {
		const binary = pocketbaseBinaryPath();
		expect(path.isAbsolute(binary)).toBe(true);
		expect(fs.statSync(binary).isFile()).toBe(true);
		expect(binary).toContain(`pocketbase-server-${process.platform}-${process.arch}`);
	});

	test('a platform with no binary installed is an error to report, not an exit', () => {
		expect(() => pocketbaseBinaryPath('plan9', 'mips')).toThrow(
			/PocketBase binary for plan9-mips is not installed[\s\S]*Reinstall/
		);
	});
});

describe('superuser commands', () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-pb-'));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	// No package.json, no node_modules, no lockfile: nothing a package manager
	// could find `pocketbase-server` through.
	test('run in a directory with nothing installed', async () => {
		await createSuperuser(root, 'admin@example.com', 'correct-horse-battery');
		expect(fs.existsSync(path.join(root, 'data', 'data.db'))).toBe(true);
		await upsertSuperuser(root, 'admin@example.com', 'another-horse-battery');
	}, 30_000);

	test('a failure names the account and never the password', async () => {
		await createSuperuser(root, 'admin@example.com', 'correct-horse-battery');
		const again = createSuperuser(root, 'admin@example.com', 'correct-horse-battery');
		await expect(again).rejects.toThrow(/could not create the superuser admin@example\.com/);
		await expect(again).rejects.not.toThrow(/correct-horse-battery/);
	}, 30_000);
});
