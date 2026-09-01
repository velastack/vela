import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { applyBuildEnv } from './build-env.ts';

describe('applyBuildEnv', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-build-env-'));
		fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}\n');
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	// The regression this file exists for: without it, every prerendered page in
	// an app with a backend fails the build with `[500] GET /`.
	test('tells @velastack/pocketbase that this is a build', () => {
		const env: NodeJS.ProcessEnv = {};
		applyBuildEnv(tmpDir, env);
		expect(env.VITE_BUILD).toBe('true');
	});

	test('points the data directory at the project', () => {
		const env: NodeJS.ProcessEnv = {};
		applyBuildEnv(tmpDir, env);
		expect(env.VELA_DATA_DIR).toBe(path.join(tmpDir, 'data'));
	});

	test('leaves a data directory the caller already chose', () => {
		const env: NodeJS.ProcessEnv = { VELA_DATA_DIR: '/somewhere/else' };
		applyBuildEnv(tmpDir, env);
		expect(env.VELA_DATA_DIR).toBe('/somewhere/else');
	});
});
