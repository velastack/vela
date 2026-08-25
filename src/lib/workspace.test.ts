import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { findWorkspaceRoot, hasBackend } from './workspace.ts';

describe('findWorkspaceRoot', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-workspace-test-'));
		fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}\n');
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('returns the directory holding package.json', () => {
		expect(findWorkspaceRoot(tmpDir)).toBe(tmpDir);
	});

	test('walks up from a nested directory', () => {
		const nested = path.join(tmpDir, 'src', 'routes');
		fs.mkdirSync(nested, { recursive: true });
		expect(findWorkspaceRoot(nested)).toBe(tmpDir);
	});
});

describe('hasBackend', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-workspace-test-'));
		fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}\n');
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('returns true when the project has a data directory', () => {
		fs.mkdirSync(path.join(tmpDir, 'data'));
		expect(hasBackend(tmpDir)).toBe(true);
	});

	test('returns false for a static project, which has no data directory', () => {
		expect(hasBackend(tmpDir)).toBe(false);
	});

	test('finds the backend from a nested directory', () => {
		fs.mkdirSync(path.join(tmpDir, 'data'));
		const nested = path.join(tmpDir, 'src', 'routes');
		fs.mkdirSync(nested, { recursive: true });
		expect(hasBackend(nested)).toBe(true);
	});
});
