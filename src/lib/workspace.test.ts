import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	detectRouteGroups,
	detectUi,
	findWorkspaceRoot,
	hasApiRoutes,
	hasBackend,
	localDataDir
} from './workspace.ts';

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

	const withPocketbase = () =>
		fs.writeFileSync(
			path.join(tmpDir, 'package.json'),
			JSON.stringify({ dependencies: { 'pocketbase-sveltekit': '^0.28.0' } })
		);

	test('returns true when the project has a data directory and the PocketBase client', () => {
		withPocketbase();
		fs.mkdirSync(path.join(tmpDir, 'data'));
		expect(hasBackend(tmpDir)).toBe(true);
	});

	// `data/` is also VELA_DATA_DIR: a self-hosted CMS on adapter-node creates it
	// for cms.sqlite, and that must not send every command looking for PocketBase.
	test('returns false for a data directory without PocketBase', () => {
		fs.mkdirSync(path.join(tmpDir, 'data'));
		expect(hasBackend(tmpDir)).toBe(false);
	});

	test('returns false for the dependency alone, before the backend is enabled', () => {
		withPocketbase();
		expect(hasBackend(tmpDir)).toBe(false);
	});

	test('returns false for a static project, which has no data directory', () => {
		expect(hasBackend(tmpDir)).toBe(false);
	});

	test('finds the backend from a nested directory', () => {
		withPocketbase();
		fs.mkdirSync(path.join(tmpDir, 'data'));
		const nested = path.join(tmpDir, 'src', 'routes');
		fs.mkdirSync(nested, { recursive: true });
		expect(hasBackend(nested)).toBe(true);
	});
});

describe('hasApiRoutes', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-workspace-test-'));
		fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}\n');
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('returns false without an api directory', () => {
		expect(hasApiRoutes(tmpDir)).toBe(false);
	});

	test("ignores the template's README, which every minimal project ships", () => {
		const api = path.join(tmpDir, 'src', 'routes', 'api');
		fs.mkdirSync(api, { recursive: true });
		fs.writeFileSync(path.join(api, 'README.md'), '# API Routes\n');
		expect(hasApiRoutes(tmpDir)).toBe(false);
	});

	test('returns true once the directory holds anything else', () => {
		const api = path.join(tmpDir, 'src', 'routes', 'api');
		fs.mkdirSync(api, { recursive: true });
		fs.writeFileSync(path.join(api, 'README.md'), '# API Routes\n');
		fs.writeFileSync(path.join(api, 'server.test.ts'), '');
		expect(hasApiRoutes(tmpDir)).toBe(true);
	});
});

describe('localDataDir', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-workspace-test-'));
		fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}\n');
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('is the data directory at the workspace root', () => {
		expect(localDataDir(tmpDir)).toBe(path.join(tmpDir, 'data'));
	});

	test('answers the same from a nested directory', () => {
		const nested = path.join(tmpDir, 'src', 'routes');
		fs.mkdirSync(nested, { recursive: true });
		expect(localDataDir(nested)).toBe(path.join(tmpDir, 'data'));
	});

	// A project without a package.json is not a workspace, and the caller still
	// needs a path back rather than an exception.
	test('falls back to the directory it was given', () => {
		const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-orphan-'));
		try {
			expect(localDataDir(orphan)).toBe(path.join(orphan, 'data'));
		} finally {
			fs.rmSync(orphan, { recursive: true, force: true });
		}
	});
});

describe('detectUi', () => {
	let tmpDir: string;

	const writePackageJson = (devDependencies: Record<string, string>) =>
		fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ devDependencies }));

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-workspace-test-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('a bare SvelteKit project is plain', () => {
		writePackageJson({ '@sveltejs/kit': '^2.0.0' });
		expect(detectUi(tmpDir)).toBe('plain');
	});

	test('components.json plus the package is shadcn', () => {
		writePackageJson({ 'shadcn-svelte': '^1.6.0' });
		fs.writeFileSync(path.join(tmpDir, 'components.json'), JSON.stringify({ style: 'vega' }));
		expect(detectUi(tmpDir)).toBe('shadcn');
	});

	test('bits-ui counts as the package, for shadcn-svelte projects vela did not create', () => {
		writePackageJson({ 'bits-ui': '^2.0.0' });
		fs.writeFileSync(path.join(tmpDir, 'components.json'), '{}');
		expect(detectUi(tmpDir)).toBe('shadcn');
	});

	test('components.json without the package is not enough', () => {
		writePackageJson({});
		fs.writeFileSync(path.join(tmpDir, 'components.json'), '{}');
		expect(detectUi(tmpDir)).toBe('plain');
	});

	test('the package without components.json is not enough', () => {
		writePackageJson({ 'bits-ui': '^2.0.0' });
		expect(detectUi(tmpDir)).toBe('plain');
	});
});

describe('detectRouteGroups', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-workspace-test-'));
		fs.mkdirSync(path.join(tmpDir, 'src', 'routes'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('a bare SvelteKit project has no groups', () => {
		expect(detectRouteGroups(tmpDir)).toEqual({ public: null, app: null });
	});

	test('a vela project has (public), and (app) once auth is enabled', () => {
		fs.mkdirSync(path.join(tmpDir, 'src', 'routes', '(public)'));
		expect(detectRouteGroups(tmpDir)).toEqual({ public: '(public)', app: null });

		fs.mkdirSync(path.join(tmpDir, 'src', 'routes', '(app)'));
		expect(detectRouteGroups(tmpDir)).toEqual({ public: '(public)', app: '(app)' });
	});
});
