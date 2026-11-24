import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { localExecCommand, runScriptCommand, scriptAgent } from './package-manager.ts';

describe('the agent scripts run with', () => {
	let root: string;
	const all = () => true;
	const none = () => false;
	const touch = (...names: string[]) => {
		for (const name of names) fs.writeFileSync(path.join(root, name), '');
	};

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-agent-'));
		fs.writeFileSync(path.join(root, 'package.json'), '{}');
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('npm for an npm project', async () => {
		touch('package-lock.json');
		expect(await scriptAgent(root, all)).toBe('npm');
	});

	test('npm with no lockfile at all', async () => {
		expect(await scriptAgent(root, all)).toBe('npm');
	});

	// A CI runner that ran `npm ci` has no pnpm; the detector alone answers pnpm.
	test('npm when package-lock.json sits beside another lockfile', async () => {
		touch('package-lock.json', 'pnpm-lock.yaml');
		expect(await scriptAgent(root, all)).toBe('npm');
		fs.rmSync(path.join(root, 'pnpm-lock.yaml'));
		touch('yarn.lock');
		expect(await scriptAgent(root, all)).toBe('npm');
	});

	test('the detected agent when it is installed', async () => {
		touch('pnpm-lock.yaml');
		expect(await scriptAgent(root, all)).toBe('pnpm');
	});

	test('npm when the detected agent is not on the PATH', async () => {
		touch('pnpm-lock.yaml');
		expect(await scriptAgent(root, none)).toBe('npm');
	});

	test('the nearest lockfile decides, from a subdirectory too', async () => {
		touch('pnpm-lock.yaml');
		const sub = path.join(root, 'packages', 'app');
		fs.mkdirSync(sub, { recursive: true });
		expect(await scriptAgent(sub, all)).toBe('pnpm');
		touch('package-lock.json');
		expect(await scriptAgent(sub, all)).toBe('npm');
	});

	test('scripts run through the agent', async () => {
		touch('pnpm-lock.yaml');
		expect(await runScriptCommand(root, 'build', [], all)).toEqual({
			agent: 'pnpm',
			command: 'pnpm',
			args: ['run', 'build']
		});
		expect(await runScriptCommand(root, 'build', [], none)).toEqual({
			agent: 'npm',
			command: 'npm',
			args: ['run', 'build']
		});
	});

	test('installed binaries run locally, never through dlx', async () => {
		touch('pnpm-lock.yaml');
		expect(await localExecCommand(root, ['vite', 'build'], all)).toEqual({
			agent: 'pnpm',
			command: 'pnpm',
			args: ['exec', 'vite', 'build']
		});
		touch('package-lock.json');
		expect(await localExecCommand(root, ['vite', 'build'], all)).toEqual({
			agent: 'npm',
			command: 'npx',
			args: ['--yes', 'vite', 'build']
		});
	});

	// `yarn exec vitest -- run` hands vitest the `--` too.
	test('yarn 1 goes through npx', async () => {
		touch('yarn.lock');
		expect(await localExecCommand(root, ['vitest', 'run'], all)).toMatchObject({
			command: 'npx',
			args: ['--yes', 'vitest', 'run']
		});
	});

	test('bun runs its own', async () => {
		touch('bun.lock');
		expect(await localExecCommand(root, ['wuchale'], all)).toMatchObject({
			command: 'bun',
			args: ['x', 'wuchale']
		});
	});
});
