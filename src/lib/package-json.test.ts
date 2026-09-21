import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
	dropTemplateAdapters,
	fillTemplatePlaceholders,
	mergePackageJson,
	readTemplatePackageJson,
	toValidPackageName
} from './package-json.ts';
import { listProjectTemplates } from './templates.ts';

describe('dropTemplateAdapters', () => {
	const template = {
		devDependencies: { '@sveltejs/adapter-auto': '^7.0.1', '@sveltejs/kit': '^2.70.3' }
	};

	test('keeps the adapter the project already has', () => {
		const user = { devDependencies: { '@sveltejs/adapter-node': '^5.5.7' } };
		const merged = mergePackageJson(user, dropTemplateAdapters(user, template)).merged;
		expect(merged.devDependencies).toEqual({
			'@sveltejs/adapter-node': '^5.5.7',
			'@sveltejs/kit': '^2.70.3'
		});
	});

	test('adds the template adapter to a project without one', () => {
		const user = { devDependencies: {} };
		expect(dropTemplateAdapters(user, template)).toEqual(template);
	});
});

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
				appName: 'Nathan C:\\ App',
				cliVersion: '0.9.0'
			})
		).toBe("name: 'Nathan C:\\\\ App'");
	});

	// Escaping the apostrophe in place would leave `'Nathan\'s App'`, which
	// prettier rewrites to double quotes — failing the new project's own lint.
	test('double-quotes a display name holding an apostrophe', () => {
		expect(
			fillTemplatePlaceholders("name: '~APP_NAME~'", {
				appName: "Nathan's App",
				cliVersion: '0.9.0'
			})
		).toBe('name: "Nathan\'s App"');
	});

	test('keeps single quotes when the name holds double quotes too', () => {
		expect(
			fillTemplatePlaceholders("name: '~APP_NAME~'", {
				appName: 'The "Best" App',
				cliVersion: '0.9.0'
			})
		).toBe('name: \'The "Best" App\'');
		// A tie goes to the single quote the templates otherwise use.
		expect(
			fillTemplatePlaceholders("name: '~APP_NAME~'", {
				appName: 'Nathan\'s "Best" App\'s',
				cliVersion: '0.9.0'
			})
		).toBe("name: 'Nathan\\'s \"Best\" App\\'s'");
		// More apostrophes than double quotes: double quoting escapes less.
		expect(
			fillTemplatePlaceholders("name: '~APP_NAME~'", {
				appName: "It's Nathan's App's \"X\"",
				cliVersion: '0.9.0'
			})
		).toBe('name: "It\'s Nathan\'s App\'s \\"X\\""');
	});

	test('a placeholder outside quotes is still escaped in place', () => {
		expect(
			fillTemplatePlaceholders('name: `~APP_NAME~`', {
				appName: "Nathan's App",
				cliVersion: '0.9.0'
			})
		).toBe("name: `Nathan\\'s App`");
	});

	// A `$&` in an app name is text, not a replacement pattern.
	test('treats dollar patterns in the app name as literal', () => {
		expect(
			fillTemplatePlaceholders("name: '~APP_NAME~'", { appName: '$& $1', cliVersion: '0.9.0' })
		).toBe("name: '$& $1'");
	});

	test('fills the site URL and CMS endpoint when given', () => {
		expect(
			fillTemplatePlaceholders("url: '~SITE_URL~', cmsEndpoint: '~CMS_ENDPOINT~'", {
				appName: 'app',
				cliVersion: '0.9.0',
				siteUrl: 'https://vela-site-origin.invalid',
				cmsEndpoint: 'https://velastack.dev/v1/projects/2tj321uzke7k7fn/cms'
			})
		).toBe(
			"url: 'https://vela-site-origin.invalid', cmsEndpoint: 'https://velastack.dev/v1/projects/2tj321uzke7k7fn/cms'"
		);
	});

	// A site without a CMS yet must still be a valid, offline project.
	test('defaults the site URL to the dev server and the CMS endpoint to empty', () => {
		expect(
			fillTemplatePlaceholders("url: '~SITE_URL~', cmsEndpoint: '~CMS_ENDPOINT~'", {
				appName: 'app',
				cliVersion: '0.9.0'
			})
		).toBe("url: 'http://localhost:5173', cmsEndpoint: ''");
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

		test(`${name} names the app in src/lib/site.ts`, () => {
			const raw = fs.readFileSync(path.join(dir, 'src', 'lib', 'site.template.ts'), 'utf8');
			const filled = fillTemplatePlaceholders(raw, { appName: 'My App', cliVersion: '9.9.9' });
			expect(filled).toContain("name: 'My App'");
			expect(filled).toContain("url: 'http://localhost:5173'");
		});

		// The bug this guards: `Nathan's App` landed as `'Nathan\'s App'`, which
		// prettier rewrites, so a project failed its own `npm run lint` the
		// moment it was created. Checked against real prettier with the options
		// the template ships, rather than restating the quoting rule here.
		describe(`${name} site.ts is prettier-clean`, () => {
			const NAMES = [
				'My App',
				"Nathan's App",
				'The "Best" App',
				"It's Nathan's App's \"X\"",
				'Backslash C:\\ App',
				"L'Étoile — café & co."
			];

			test.each(NAMES)('%s', async (appName) => {
				const prettier = await import('prettier');
				const site = path.join(dir, 'src', 'lib', 'site.ts');
				const raw = fs.readFileSync(path.join(dir, 'src', 'lib', 'site.template.ts'), 'utf8');
				const filled = fillTemplatePlaceholders(raw, { appName, cliVersion: '9.9.9' });
				const options = await prettier.resolveConfig(site);

				expect(await prettier.format(filled, { ...options, parser: 'typescript' })).toBe(filled);
			});
		});
	}
});
