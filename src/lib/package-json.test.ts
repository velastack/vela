import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
	fillTemplatePlaceholders,
	mergePackageJson,
	readTemplatePackageJson,
	toValidPackageName
} from './package-json.ts';
import { listProjectTemplates } from './templates.ts';

describe('mergePackageJson', () => {
	test('adds missing devDependencies', () => {
		const { merged, added, conflicts, replaced } = mergePackageJson(
			{ devDependencies: { vite: '^5.0.0' } },
			{ devDependencies: { vite: '^5.0.0', svelte: '^5.0.0', tailwindcss: '^4.0.0' } }
		);
		expect(merged.devDependencies).toEqual({
			svelte: '^5.0.0',
			tailwindcss: '^4.0.0',
			vite: '^5.0.0'
		});
		expect(added.map((c) => c.name).sort()).toEqual(['svelte', 'tailwindcss']);
		expect(conflicts).toEqual([]);
		expect(replaced).toEqual([]);
	});

	test('keeps user dependency version on conflict and reports it', () => {
		const { merged, conflicts } = mergePackageJson(
			{ devDependencies: { svelte: '^4.0.0' } },
			{ devDependencies: { svelte: '^5.0.0' } }
		);
		expect(merged.devDependencies).toEqual({ svelte: '^4.0.0' });
		expect(conflicts).toEqual([
			{ kind: 'devDependencies', name: 'svelte', templateValue: '^5.0.0', userValue: '^4.0.0' }
		]);
	});

	test('does not duplicate a package across dependencies / devDependencies', () => {
		const { merged, added, conflicts } = mergePackageJson(
			{ dependencies: { vite: '^5.0.0' } },
			{ devDependencies: { vite: '^5.0.0' } }
		);
		expect(merged.dependencies).toEqual({ vite: '^5.0.0' });
		expect(merged.devDependencies).toEqual({});
		expect(added).toEqual([]);
		expect(conflicts).toEqual([]);
	});

	test('adds scripts when absent', () => {
		const { merged, added, replaced } = mergePackageJson(
			{ scripts: { dev: 'vite dev' } },
			{ scripts: { dev: 'vite dev', build: 'vela build', check: 'svelte-check' } }
		);
		expect(merged.scripts).toEqual({
			build: 'vela build',
			check: 'svelte-check',
			dev: 'vite dev'
		});
		expect(added.map((c) => c.name).sort()).toEqual(['build', 'check']);
		expect(replaced).toEqual([]);
	});

	test('replaces scripts that differ and reports the replacement', () => {
		const { merged, replaced, conflicts } = mergePackageJson(
			{ scripts: { dev: 'vite dev', build: 'vite build' } },
			{ scripts: { dev: 'vela dev', build: 'vela build' } }
		);
		expect(merged.scripts).toEqual({ dev: 'vela dev', build: 'vela build' });
		expect(replaced).toEqual([
			{ kind: 'scripts', name: 'dev', templateValue: 'vela dev', userValue: 'vite dev' },
			{ kind: 'scripts', name: 'build', templateValue: 'vela build', userValue: 'vite build' }
		]);
		expect(conflicts).toEqual([]);
	});

	test('leaves matching scripts alone without reporting', () => {
		const { merged, added, replaced } = mergePackageJson(
			{ scripts: { dev: 'vela dev' } },
			{ scripts: { dev: 'vela dev' } }
		);
		expect(merged.scripts).toEqual({ dev: 'vela dev' });
		expect(added).toEqual([]);
		expect(replaced).toEqual([]);
	});

	test('preserves top-level user fields', () => {
		const { merged } = mergePackageJson(
			{ name: 'my-app', version: '0.1.0', type: 'module', private: true },
			{ name: '~TODO~', version: '0.0.1', devDependencies: { svelte: '^5.0.0' } }
		);
		expect(merged.name).toBe('my-app');
		expect(merged.version).toBe('0.1.0');
		expect(merged.type).toBe('module');
		expect(merged.private).toBe(true);
	});

	test('handles user with no deps at all', () => {
		const { merged, added } = mergePackageJson(
			{},
			{ devDependencies: { svelte: '^5.0.0' }, scripts: { dev: 'vela dev' } }
		);
		expect(merged.devDependencies).toEqual({ svelte: '^5.0.0' });
		expect(merged.scripts).toEqual({ dev: 'vela dev' });
		expect(added).toHaveLength(2);
	});

	test('does not mutate the input', () => {
		const user = { devDependencies: { vite: '^5.0.0' } };
		mergePackageJson(user, { devDependencies: { svelte: '^5.0.0' } });
		expect(user.devDependencies).toEqual({ vite: '^5.0.0' });
	});
});

describe('toValidPackageName', () => {
	test('normalises casing and spaces', () => {
		expect(toValidPackageName('My App')).toBe('my-app');
	});

	test('strips leading dots and underscores', () => {
		expect(toValidPackageName('.foo')).toBe('foo');
		expect(toValidPackageName('_bar')).toBe('bar');
	});

	test('replaces invalid characters with dashes', () => {
		expect(toValidPackageName('hello@world!')).toBe('hello-world-');
	});
});

describe('fillTemplatePlaceholders', () => {
	test('substitutes the app name and the CLI version', () => {
		const raw = '{"name":"~TODO~","devDependencies":{"vela":"^~VELA_VERSION~"}}';
		expect(fillTemplatePlaceholders(raw, { appName: 'My App', cliVersion: '0.9.0' })).toBe(
			'{"name":"my-app","devDependencies":{"vela":"^0.9.0"}}'
		);
	});

	test('normalizes the app name but leaves the version verbatim', () => {
		const raw = '{"name":"~TODO~","v":"~VELA_VERSION~"}';
		expect(
			fillTemplatePlaceholders(raw, { appName: '  Weird Name!  ', cliVersion: '1.2.3-beta.4' })
		).toBe('{"name":"weird-name-","v":"1.2.3-beta.4"}');
	});

	test('replaces every occurrence', () => {
		expect(
			fillTemplatePlaceholders('~TODO~ ~TODO~ ~VELA_VERSION~ ~VELA_VERSION~', {
				appName: 'app',
				cliVersion: '0.9.0'
			})
		).toBe('app app 0.9.0 0.9.0');
	});

	test('leaves source without placeholders untouched', () => {
		const raw = '{"name":"already-named"}';
		expect(fillTemplatePlaceholders(raw, { appName: 'app', cliVersion: '0.9.0' })).toBe(raw);
	});

	// `~APP_NAME~` keeps the name the user typed, where `~TODO~` normalizes it.
	test('substitutes the display name verbatim', () => {
		expect(
			fillTemplatePlaceholders("name: '~APP_NAME~', pkg: '~TODO~'", {
				appName: 'My App',
				cliVersion: '0.9.0'
			})
		).toBe("name: 'My App', pkg: 'my-app'");
	});

	test('escapes a display name that would break out of its string literal', () => {
		expect(
			fillTemplatePlaceholders("name: '~APP_NAME~'", {
				appName: "Nathan's C:\\ App",
				cliVersion: '0.9.0'
			})
		).toBe("name: 'Nathan\\'s C:\\\\ App'");
	});

	// A `$&` in an app name is text, not a replacement pattern.
	test('treats dollar patterns in the app name as literal', () => {
		expect(
			fillTemplatePlaceholders("name: '~APP_NAME~'", { appName: '$& $1', cliVersion: '0.9.0' })
		).toBe("name: '$& $1'");
	});
});

describe('shipped templates', () => {
	for (const { name, dir } of listProjectTemplates()) {
		test(`${name} pins the CLI to the running version, not a hardcoded one`, () => {
			const file = path.join(dir, 'package.template.json');
			const pkg = readTemplatePackageJson(file, { appName: 'app', cliVersion: '9.9.9' });
			const deps = pkg.devDependencies ?? {};
			expect(deps.vela).toBe('^9.9.9');
		});

		test(`${name} leaves no unsubstituted placeholders`, () => {
			const file = path.join(dir, 'package.template.json');
			const raw = fs.readFileSync(file, 'utf8');
			const filled = fillTemplatePlaceholders(raw, { appName: 'app', cliVersion: '9.9.9' });
			expect(filled).not.toMatch(/~[A-Z_]+~|~TODO~/);
		});
	}
});
