import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
	DEFAULT_TEMPLATE,
	TEMPLATE_MANIFEST,
	findProjectTemplate,
	listProjectTemplates,
	projectTemplateNames,
	templateChoicesMessage,
	templatesDir
} from './templates.ts';

describe('templatesDir', () => {
	test('resolves the packaged templates directory', () => {
		expect(fs.existsSync(templatesDir())).toBe(true);
	});
});

describe('listProjectTemplates', () => {
	test('finds the templates that ship with the CLI', () => {
		expect(listProjectTemplates().map((t) => t.name)).toEqual(['minimal', 'static']);
	});

	// `templates/server` holds the provisioning scripts, not a scaffoldable project.
	test('ignores template directories without a manifest', () => {
		expect(fs.existsSync(path.join(templatesDir(), 'server'))).toBe(true);
		expect(listProjectTemplates().map((t) => t.name)).not.toContain('server');
	});

	test('every template describes itself', () => {
		for (const template of listProjectTemplates()) {
			expect(template.description.length).toBeGreaterThan(0);
		}
	});

	// `vela create` scaffolds package.json from this file, so a template without
	// one would fail after it had already copied itself into the target.
	test('every template ships a package.template.json', () => {
		for (const template of listProjectTemplates()) {
			expect(fs.existsSync(path.join(template.dir, 'package.template.json'))).toBe(true);
		}
	});

	test('the default template exists', () => {
		expect(projectTemplateNames()).toContain(DEFAULT_TEMPLATE);
	});
});

describe('backend', () => {
	test('minimal scaffolds PocketBase, static does not', () => {
		expect(findProjectTemplate('minimal').backend).toBe(true);
		expect(findProjectTemplate('static').backend).toBe(false);
	});

	// A backend template is one whose hooks wire up PocketBase — not merely one
	// that has hooks, since a frontend-only template may have its own. The flag
	// and the files have to agree or `vela create` skips the wrong step.
	test('the manifest flag matches whether the template wires up PocketBase', () => {
		for (const template of listProjectTemplates()) {
			const hooks = path.join(template.dir, 'src', 'hooks.server.ts');
			const wiresUpPocketbase =
				fs.existsSync(hooks) && fs.readFileSync(hooks, 'utf8').includes('@velastack/pocketbase');
			expect(wiresUpPocketbase).toBe(template.backend);
		}
	});

	test('filters by backend', () => {
		expect(projectTemplateNames({ backend: true })).toEqual(['minimal']);
		expect(projectTemplateNames({ backend: false })).toEqual(['static']);
	});
});

describe('app name and URL', () => {
	function files(dir: string): string[] {
		return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : files(full);
			return /\.(svelte|ts|js)$/.test(entry.name) ? [full] : [];
		});
	}

	// `src/lib/site.ts` is where they live; PocketBase's settings only mirror the
	// name for its emails, and a static site has no PocketBase at all.
	test('no template reads them from PocketBase meta', () => {
		for (const template of listProjectTemplates()) {
			const offenders = files(template.dir).filter((file) =>
				/\b(?:locals|data)\??\.meta\b/.test(fs.readFileSync(file, 'utf8'))
			);
			expect(offenders).toEqual([]);
		}
	});
});

describe('findProjectTemplate', () => {
	test('returns the directory the template lives in', () => {
		const template = findProjectTemplate('minimal');
		expect(template.dir).toBe(path.join(templatesDir(), 'minimal'));
		expect(fs.existsSync(path.join(template.dir, TEMPLATE_MANIFEST))).toBe(true);
	});

	test('throws for an unknown template', () => {
		expect(() => findProjectTemplate('vue')).toThrow('Template not found: vue');
	});
});

describe('categories', () => {
	test('built-ins are starters', () => {
		for (const template of listProjectTemplates()) {
			expect(template.category).toBe('starter');
			expect(template.source).toBe('builtin');
		}
	});

	test('choices are grouped by category with starters first', () => {
		const message = templateChoicesMessage([
			{ name: 'confetti', description: '', backend: true, source: 'remote', category: 'blog' },
			{ name: 'static', description: '', backend: false, source: 'builtin', category: 'starter' },
			{ name: 'broadsheet', description: '', backend: true, source: 'remote', category: 'blog' },
			{ name: 'minimal', description: '', backend: true, source: 'builtin', category: 'starter' }
		]);
		expect(message).toBe('starter: minimal, static; blog: broadsheet, confetti');
	});
});

describe('SvelteKit 3', () => {
	/** Every text file a template ships, as [template-relative path, contents]. */
	function textFiles(dir: string): [string, string][] {
		return fs
			.globSync('**/*', { cwd: dir, withFileTypes: true })
			.filter(
				(entry) =>
					entry.isFile() &&
					entry.name !== '.DS_Store' &&
					!/\.(jpe?g|png|gif|webp|ico|db)$/.test(entry.name) &&
					!entry.parentPath.split(path.sep).includes('node_modules')
			)
			.map((entry) => {
				const full = path.join(entry.parentPath, entry.name);
				return [path.relative(dir, full), fs.readFileSync(full, 'utf8')];
			});
	}

	/** The body of each `prerender: { … }` object literal in a config file. */
	function prerenderBlocks(source: string): string[] {
		const blocks: string[] = [];
		for (const match of source.matchAll(/\bprerender\s*:\s*\{/g)) {
			let depth = 1;
			let i = match.index! + match[0].length;
			const start = i;
			for (; i < source.length && depth > 0; i++) {
				if (source[i] === '{') depth++;
				else if (source[i] === '}') depth--;
			}
			blocks.push(source.slice(start, i - 1));
		}
		return blocks;
	}

	/** Names imported from `$app/env/private` and `$app/env/public`. */
	function envImports(source: string): string[] {
		const imports = source.matchAll(
			/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]\$app\/env\/(?:private|public)['"]/g
		);
		return [...imports].flatMap((match) =>
			match[1]!
				.split(',')
				.map((name) =>
					name
						.trim()
						.split(/\s+as\s+/)[0]!
						.trim()
				)
				.filter(Boolean)
		);
	}

	/** The variables `src/env.ts` declares in its `defineEnvVars({ … })` call. */
	function declaredEnvVars(source: string): string[] {
		return [...source.matchAll(/^\t([A-Z_][A-Z0-9_]*)\s*:\s*\{/gm)].map((match) => match[1]!);
	}

	// Kit 3 removed `$lib`, `svelte.config.*` and `prerender.origin`, and deprecated
	// `$env/*` and `$app/environment`: a template that still mentions one either
	// fails to build or teaches the old API.
	test.each([
		['$lib', /\$lib\b/],
		['$env/', /\$env\//],
		['$app/environment', /\$app\/environment\b/],
		['svelte.config', /svelte\.config/],
		['prerender.origin', /prerender\.origin/]
	])('no template mentions %s', (_label, pattern) => {
		for (const template of listProjectTemplates()) {
			const offenders = textFiles(template.dir)
				.filter(([, contents]) => pattern.test(contents))
				.map(([rel]) => `${template.name}/${rel}`);
			expect(offenders).toEqual([]);
		}
	});

	test('no template sets an origin under prerender', () => {
		for (const template of listProjectTemplates()) {
			const config = fs.readFileSync(path.join(template.dir, 'vite.config.ts'), 'utf8');
			for (const block of prerenderBlocks(config)) {
				expect(block).not.toMatch(/\borigin\b/);
			}
		}
	});

	// Without a declaration in src/env.ts Kit 3 exposes no variable at all, so
	// a named import of an undeclared one fails the build.
	test('src/env.ts declares every variable a template imports', () => {
		for (const template of listProjectTemplates()) {
			const imported = new Set(
				textFiles(template.dir)
					.filter(([rel]) => /\.(ts|js|svelte)$/.test(rel))
					.flatMap(([, contents]) => envImports(contents))
			);
			const envFile = path.join(template.dir, 'src', 'env.ts');
			const declared = fs.existsSync(envFile)
				? declaredEnvVars(fs.readFileSync(envFile, 'utf8'))
				: [];
			expect([...imported].filter((name) => !declared.includes(name))).toEqual([]);
		}
	});

	test('minimal declares the variables its server code reads', () => {
		const envFile = path.join(findProjectTemplate('minimal').dir, 'src', 'env.ts');
		expect(declaredEnvVars(fs.readFileSync(envFile, 'utf8')).sort()).toEqual([
			'POCKETBASE_SUPERUSER_EMAIL',
			'POCKETBASE_SUPERUSER_PASSWORD',
			'POCKETBASE_URL',
			'TEST',
			'WORKFLOWS_CONCURRENCY',
			'WORKFLOWS_ENABLED'
		]);
	});

	// sv's rules: a module gets `.js`, a directory `/index.js`, and `.svelte`
	// and `.svg` keep their own extension. `site.ts` ships as `site.template.ts`.
	test('every #lib import names a file the template ships', () => {
		for (const template of listProjectTemplates()) {
			const lib = path.join(template.dir, 'src', 'lib');
			const dangling: string[] = [];
			// Code and the docs that show it; components.json holds directory aliases.
			const sources = textFiles(template.dir).filter(([rel]) => /\.(ts|js|svelte|md)$/.test(rel));
			for (const [rel, contents] of sources) {
				for (const match of contents.matchAll(/['"`]#lib\/([^'"`]+)['"`]/g)) {
					const target = match[1]!;
					const candidates = /\.(svelte|svg|svx)$/.test(target)
						? [target]
						: target.endsWith('.js')
							? [target, target.replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.template.ts')]
							: [];
					if (!candidates.some((candidate) => fs.existsSync(path.join(lib, candidate)))) {
						dangling.push(`${template.name}/${rel} -> #lib/${target}`);
					}
				}
			}
			expect(dangling).toEqual([]);
		}
	});

	test('package.json maps #lib and requires the Node that Kit 3 does', () => {
		for (const template of listProjectTemplates()) {
			const pkg = JSON.parse(
				fs.readFileSync(path.join(template.dir, 'package.template.json'), 'utf8')
			);
			expect(pkg.imports).toEqual({ '#lib': './src/lib/index.js', '#lib/*': './src/lib/*' });
			expect(pkg.engines).toEqual({ node: '>=22.17' });
			expect(pkg.devDependencies['@sveltejs/kit']).toBe('^3.0.0');
		}
	});

	// formsnap 2 peers superforms ^2. The override has to name the version
	// itself: npm 10, which Node 22 ships, cannot resolve a `$sveltekit-superforms`
	// reference to a devDependency.
	test('the formsnap override follows the superforms pin', () => {
		for (const template of listProjectTemplates()) {
			const pkg = JSON.parse(
				fs.readFileSync(path.join(template.dir, 'package.template.json'), 'utf8')
			);
			if (!pkg.devDependencies.formsnap) continue;
			expect(pkg.devDependencies['sveltekit-superforms']).toMatch(/^\d/);
			expect(pkg.overrides?.formsnap?.['sveltekit-superforms']).toBe(
				pkg.devDependencies['sveltekit-superforms']
			);
		}
	});
});
