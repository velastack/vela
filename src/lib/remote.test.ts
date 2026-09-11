import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	instanceHasBackend,
	parseResult,
	serverScriptsDigest,
	serverTemplatesDir,
	type InstanceState
} from './remote.ts';

describe('instanceHasBackend', () => {
	const base: InstanceState = { appId: 'a', name: 'a', env: 'prod', instance: 'a' };

	test('is what the server recorded, whatever ports it allocated', () => {
		expect(instanceHasBackend({ ...base, backend: false, pbPort: 8101 })).toBe(false);
		expect(instanceHasBackend({ ...base, backend: true, pbPort: 8101 })).toBe(true);
	});

	test('falls back to the port pair for state written before the flag', () => {
		expect(instanceHasBackend({ ...base, pbPort: 8101 })).toBe(true);
		expect(instanceHasBackend({ ...base })).toBe(false);
	});

	test('an instance that was never deployed has no database', () => {
		expect(instanceHasBackend(undefined)).toBe(false);
	});
});

describe('serverScriptsDigest', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-scripts-'));
		fs.mkdirSync(path.join(dir, 'systemd'));
		fs.writeFileSync(path.join(dir, 'lib.sh'), '#!/bin/bash\n');
		fs.writeFileSync(path.join(dir, 'apply.sh'), '#!/bin/bash\n. lib.sh\n');
		fs.writeFileSync(path.join(dir, 'systemd', 'vela-web@.service'), '[Unit]\n');
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('is short, hex and deterministic', () => {
		const digest = serverScriptsDigest(dir);
		expect(digest).toMatch(/^[0-9a-f]{12}$/);
		expect(serverScriptsDigest(dir)).toBe(digest);
	});

	test('changes when any byte of any file changes', () => {
		const before = serverScriptsDigest(dir);
		fs.appendFileSync(path.join(dir, 'systemd', 'vela-web@.service'), 'Description=x\n');
		expect(serverScriptsDigest(dir)).not.toBe(before);
	});

	test('changes when a file is renamed, even with the same contents', () => {
		const before = serverScriptsDigest(dir);
		fs.renameSync(path.join(dir, 'apply.sh'), path.join(dir, 'activate.sh'));
		expect(serverScriptsDigest(dir)).not.toBe(before);
	});

	test('hashes the packaged server templates', () => {
		expect(serverScriptsDigest(serverTemplatesDir())).toMatch(/^[0-9a-f]{12}$/);
	});
});

describe('parseResult', () => {
	const run = (stdout: string) => parseResult<{ ok: boolean }>({ stdout, stderr: '', exitCode: 0 });

	test('reads the last VELA_RESULT line', () => {
		expect(run('VELA_RESULT {"ok":false}\nprogress\nVELA_RESULT {"ok":true}\n')).toEqual({
			ok: true
		});
	});

	test('is null without one, or with one that is not JSON', () => {
		expect(run('nothing here\n')).toBeNull();
		expect(run('VELA_RESULT {not json\n')).toBeNull();
	});
});
