import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	collectArtifact,
	foreignLockfile,
	hasRuntimeDependencies,
	lockfileAdvice,
	WRITE_LOCKFILE_COMMAND
} from './artifact.ts';

describe('lockfiles', () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-artifact-'));
		fs.mkdirSync(path.join(root, 'build'));
		fs.writeFileSync(path.join(root, 'build', 'index.js'), '');
		fs.writeFileSync(path.join(root, 'package.json'), '{}');
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const shipped = () => collectArtifact(root).map((entry) => path.basename(entry.localPath));

	test('an npm project ships its lockfile and needs no warning', () => {
		fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
		expect(foreignLockfile(root)).toBeUndefined();
		expect(shipped()).toContain('package-lock.json');
	});

	// The server's dependency cache is keyed on it, so it has to get there.
	test('a pnpm project ships its lockfile and is flagged', () => {
		fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
		expect(foreignLockfile(root)).toBe('pnpm-lock.yaml');
		expect(shipped()).toContain('pnpm-lock.yaml');
	});

	test('package-lock.json wins where both exist', () => {
		fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
		fs.writeFileSync(path.join(root, 'yarn.lock'), '');
		expect(foreignLockfile(root)).toBeUndefined();
	});

	test('no lockfile at all is not a foreign one', () => {
		expect(foreignLockfile(root)).toBeUndefined();
	});

	const pkg = (json: object) =>
		fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(json));

	test('runtime dependencies are what the server would install', () => {
		expect(hasRuntimeDependencies(root)).toBe(false);
		pkg({ dependencies: {}, optionalDependencies: {}, devDependencies: { vite: '^8.0.0' } });
		expect(hasRuntimeDependencies(root)).toBe(false);
		pkg({ dependencies: { argon2: '^0.44.0' } });
		expect(hasRuntimeDependencies(root)).toBe(true);
		pkg({ optionalDependencies: { fsevents: '^2.3.3' } });
		expect(hasRuntimeDependencies(root)).toBe(true);
		pkg({ peerDependencies: { svelte: '^5.0.0' } });
		expect(hasRuntimeDependencies(root)).toBe(true);
		fs.writeFileSync(path.join(root, 'package.json'), '{not json');
		expect(hasRuntimeDependencies(root)).toBe(true);
	});

	test('a pnpm project with runtime dependencies is told how to write a lockfile that works', () => {
		pkg({ dependencies: { argon2: '^0.44.0' }, devDependencies: { vite: '^8.0.0' } });
		fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
		const advice = lockfileAdvice(root)!;
		expect(advice).toContain('pnpm-lock.yaml');
		expect(advice).toContain('runtime dependencies');
		expect(advice).toContain('package-lock.json makes that reproducible');
		expect(advice).toContain(WRITE_LOCKFILE_COMMAND);
		// Run in place it fails on pnpm's node_modules; the command works on a copy.
		expect(WRITE_LOCKFILE_COMMAND).toContain('mktemp -d');
	});

	test('a pnpm project with only devDependencies is not warned: the server installs nothing', () => {
		pkg({ devDependencies: { vite: '^8.0.0' } });
		fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
		expect(lockfileAdvice(root)).toBeUndefined();
	});

	test('an npm project is not warned', () => {
		pkg({ dependencies: { argon2: '^0.44.0' } });
		fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
		fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
		expect(lockfileAdvice(root)).toBeUndefined();
	});
});
