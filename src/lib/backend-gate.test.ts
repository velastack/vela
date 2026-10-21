import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { assertBackendReady } from './backend-gate.ts';

describe('assertBackendReady', () => {
	let tmp: string;
	let cwd: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-backend-gate-'));
		fs.writeFileSync(path.join(tmp, 'package.json'), '{}\n');
		cwd = process.cwd();
		process.chdir(tmp);
	});

	afterEach(() => {
		process.chdir(cwd);
		vi.unstubAllEnvs();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test('refuses a project without PocketBase, pointing at enable backend', () => {
		expect(() => assertBackendReady('vela enable payments')).toThrow('needs a backend');
		expect(() => assertBackendReady('vela enable payments')).toThrow('vela enable backend');
	});
});
