import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	assertKit3,
	declaredMajor,
	KitVersionError,
	kitStatus,
	warnIfKit2
} from './kit-version.ts';

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-kit-version-'));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function writePackageJson(pkg: Record<string, unknown>) {
	fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg));
}

function installKit(version: string) {
	const dir = path.join(tmp, 'node_modules', '@sveltejs', 'kit');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
}

describe('declaredMajor', () => {
	test.each([
		['^2.70.3', 2],
		['~3.0.0', 3],
		['3.0.0', 3],
		['>=2', 2],
		['>= 2.5.0 <4', 2],
		['^2.0.0 || ^3.0.0', 2],
		['3.x', 3],
		['<3', 0],
		['2.0.0 - 3.0.0', 2],
		['^3.0.0-next.4', 3],
		['workspace:^3.0.0', 3],
		['npm:@sveltejs/kit@^3.1.0', 3]
	])('%s is %s', (range, major) => {
		expect(declaredMajor(range)).toBe(major);
	});

	test.each(['latest', 'next', '*', '', 'workspace:*', 'workspace:^', 'github:sveltejs/kit'])(
		'%j says nothing about a version',
		(range) => {
			expect(declaredMajor(range)).toBeNull();
		}
	);
});

describe('kitStatus', () => {
	test('reads the declared range, the installed version and a svelte.config', () => {
		writePackageJson({ devDependencies: { '@sveltejs/kit': '^2.70.3' } });
		installKit('2.70.4');
		fs.writeFileSync(path.join(tmp, 'svelte.config.js'), 'export default {};\n');
		expect(kitStatus(tmp)).toEqual({
			declaredMajor: 2,
			installedVersion: '2.70.4',
			svelteConfig: path.join(tmp, 'svelte.config.js')
		});
	});

	test('devDependencies win over dependencies', () => {
		writePackageJson({
			dependencies: { '@sveltejs/kit': '^2.0.0' },
			devDependencies: { '@sveltejs/kit': '^3.0.0' }
		});
		expect(kitStatus(tmp).declaredMajor).toBe(3);
	});

	test('a dependency-only declaration is read too', () => {
		writePackageJson({ dependencies: { '@sveltejs/kit': '~3.0.0' } });
		expect(kitStatus(tmp).declaredMajor).toBe(3);
	});

	test('no package.json, no kit, nothing installed', () => {
		expect(kitStatus(tmp)).toEqual({ declaredMajor: null, svelteConfig: null });
		writePackageJson({ devDependencies: { vite: '^8.0.12' } });
		expect(kitStatus(tmp)).toEqual({ declaredMajor: null, svelteConfig: null });
	});

	test('finds every svelte.config extension', () => {
		for (const ext of ['js', 'mjs', 'cjs', 'ts']) {
			const file = path.join(tmp, `svelte.config.${ext}`);
			fs.writeFileSync(file, '');
			expect(kitStatus(tmp).svelteConfig).toBe(file);
			fs.rmSync(file);
		}
	});
});

describe('assertKit3', () => {
	test('passes a Kit 3 project', () => {
		writePackageJson({ devDependencies: { '@sveltejs/kit': '^3.0.0' } });
		expect(() => assertKit3(tmp, 'vela bless')).not.toThrow();
	});

	test('passes a project with no SvelteKit at all', () => {
		writePackageJson({});
		expect(() => assertKit3(tmp, 'vela bless')).not.toThrow();
	});

	test('refuses a Kit 2 range, naming the command and the way forward', () => {
		writePackageJson({ devDependencies: { '@sveltejs/kit': '^2.70.3' } });
		expect(() => assertKit3(tmp, 'vela bless')).toThrow(KitVersionError);
		let message = '';
		try {
			assertKit3(tmp, 'vela bless');
		} catch (err) {
			message = (err as Error).message;
			expect((err as KitVersionError).command).toBe('npx vela@^0.15 migrate sveltekit-3');
		}
		expect(message).toContain('vela bless');
		expect(message).toContain('SvelteKit 2 project detected');
		expect(message).toContain('vela 0.15 supports SvelteKit 3 only');
		expect(message).toContain('npx vela@^0.15 migrate sveltekit-3');
		expect(message).toContain('vela@0.14');
		expect(message).toContain('@sveltejs/kit 2.x');
	});

	test('refuses a Kit 3 range that still has a svelte.config', () => {
		writePackageJson({ devDependencies: { '@sveltejs/kit': '^3.0.0' } });
		fs.writeFileSync(path.join(tmp, 'svelte.config.js'), 'export default {};\n');
		expect(() => assertKit3(tmp, 'vela enable')).toThrow(/vela enable: .*svelte\.config\.js/);
	});

	test('a range that says nothing defers to the installed version', () => {
		writePackageJson({ devDependencies: { '@sveltejs/kit': 'latest' } });
		installKit('2.70.4');
		expect(() => assertKit3(tmp, 'vela deploy')).toThrow(/@sveltejs\/kit 2\.70\.4 installed/);
		installKit('3.0.1');
		expect(() => assertKit3(tmp, 'vela deploy')).not.toThrow();
	});

	test('the declared range outranks what happens to be installed', () => {
		writePackageJson({ devDependencies: { '@sveltejs/kit': '^3.0.0' } });
		installKit('2.70.4');
		expect(() => assertKit3(tmp, 'vela deploy')).not.toThrow();
	});
});

describe('warnIfKit2', () => {
	test('says nothing on Kit 3, and warns once per process on Kit 2', () => {
		const warnings: string[] = [];
		writePackageJson({ devDependencies: { '@sveltejs/kit': '^3.0.0' } });
		warnIfKit2(tmp, (m) => warnings.push(m));
		expect(warnings).toEqual([]);

		writePackageJson({ devDependencies: { '@sveltejs/kit': '^2.70.3' } });
		warnIfKit2(tmp, (m) => warnings.push(m));
		warnIfKit2(tmp, (m) => warnings.push(m));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('npx vela@^0.15 migrate sveltekit-3');
	});
});
