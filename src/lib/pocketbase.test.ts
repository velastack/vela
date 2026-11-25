import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	createSuperuser,
	exposePocketbaseBinary,
	pocketbaseBinaryPath,
	upsertSuperuser,
	drainOutput
} from './pocketbase.ts';

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

describe('VELA_POCKETBASE_BIN, which patterns spawn', () => {
	test('is set to the resolved binary', () => {
		const env: NodeJS.ProcessEnv = {};
		exposePocketbaseBinary(env);
		expect(env.VELA_POCKETBASE_BIN).toBe(pocketbaseBinaryPath());
	});

	test('is left alone when the user set it', () => {
		const env: NodeJS.ProcessEnv = { VELA_POCKETBASE_BIN: '/opt/pocketbase/pocketbase' };
		exposePocketbaseBinary(env);
		expect(env.VELA_POCKETBASE_BIN).toBe('/opt/pocketbase/pocketbase');
	});

	test('stays unset when there is no binary to point at', () => {
		const env: NodeJS.ProcessEnv = {};
		exposePocketbaseBinary(env, () => {
			throw new Error('not installed');
		});
		expect('VELA_POCKETBASE_BIN' in env).toBe(false);
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

describe('drainOutput', () => {
	// A child that prints more than a pipe holds (64 KB on Linux) blocks on the
	// write unless somebody reads. That is how a test run froze PocketBase.
	test('lets a child that prints more than a pipe holds finish, and keeps the tail', async () => {
		const { spawn } = await import('node:child_process');
		const proc = spawn(
			process.execPath,
			['-e', "process.stdout.write('x'.repeat(300000) + 'END'); process.stderr.write('ERR');"],
			{ stdio: 'pipe' }
		);
		const output = drainOutput(proc);
		const code = await new Promise((resolve) => proc.once('close', resolve));
		expect(code).toBe(0);
		expect(output().length).toBeLessThanOrEqual(64 * 1024);
		expect(output()).toContain('END');
		expect(output()).toContain('ERR');
	});
});
