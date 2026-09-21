import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { collectArtifact, foreignLockfile } from './artifact.ts';

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
});
