import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { localesSpecifier, migrateLocalesAlias } from './locales-alias.ts';

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-locales-'));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
	const file = path.join(tmp, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function read(rel: string): string {
	return fs.readFileSync(path.join(tmp, rel), 'utf8');
}

/** velabase.dev's vite.config before its SvelteKit 3 migration, the alias inline. */
const VELABASE_VITE = `import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-node';

export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter(),
			alias: {
				$locales: 'src/locales'
			}
		})
	]
});
`;

/** What wuchale writes to src/locales for patterns' i18n. */
const WUCHALE_OUTPUT = [
	'data.js',
	'main.url.js',
	'main.loader.svelte.js',
	'main.loader.server.svelte.js',
	'js.loader.js',
	'js.loader.server.js'
];

function project(vite = VELABASE_VITE): void {
	write('package.json', `{\n\t"name": "app",\n\t"type": "module"\n}\n`);
	write('vite.config.ts', vite);
	for (const file of WUCHALE_OUTPUT) write(`src/locales/${file}`, 'export {};\n');
}

describe('localesSpecifier', () => {
	test("adds the file's real extension, as patterns' i18n imports them", () => {
		project();
		expect(localesSpecifier(tmp, 'data')).toBe('#locales/data.js');
		expect(localesSpecifier(tmp, 'main.url')).toBe('#locales/main.url.js');
		expect(localesSpecifier(tmp, 'main.loader.svelte.js')).toBe('#locales/main.loader.svelte.js');
		expect(localesSpecifier(tmp, 'main.loader')).toBe('#locales/main.loader.svelte.js');
		expect(localesSpecifier(tmp, 'js.loader.server.js')).toBe('#locales/js.loader.server.js');
		// wuchale has not generated it yet: `.js`, which is what it will write.
		expect(localesSpecifier(tmp, 'landing.loader')).toBe('#locales/landing.loader.js');
	});
});

describe('migrateLocalesAlias', () => {
	test('velabase.dev: imports entry, every specifier, then the alias; a second run changes nothing', async () => {
		project();
		write(
			'src/hooks.server.ts',
			[
				"import * as main from '$locales/main.loader.server.svelte.js';",
				"import * as js from '$locales/js.loader.server.js';",
				"import { locales } from '$locales/data';",
				"import { getLocale } from '$locales/main.url';",
				''
			].join('\n')
		);
		write(
			'src/routes/+layout.ts',
			"import { getLocale } from '$locales/main.url';\nimport '$locales/main.loader.svelte.js';\nimport '$locales/js.loader.js';\n"
		);
		write(
			'src/lib/components/language-select.svelte',
			`<script lang="ts">\n\timport { locales, type Locale } from "$locales/data.js";\n</script>\n`
		);
		write(
			'src/routes/patterns/metadata.ts',
			'export const text = "<code>$locales</code> alias";\n'
		);

		const first = await migrateLocalesAlias(tmp);
		expect(first.changed).toBe(true);
		expect(first.warnings).toEqual([]);
		expect(JSON.parse(read('package.json')).imports).toEqual({
			'#locales/*': './src/locales/*'
		});
		expect(read('src/hooks.server.ts')).toBe(
			[
				"import * as main from '#locales/main.loader.server.svelte.js';",
				"import * as js from '#locales/js.loader.server.js';",
				"import { locales } from '#locales/data.js';",
				"import { getLocale } from '#locales/main.url.js';",
				''
			].join('\n')
		);
		expect(read('src/routes/+layout.ts')).toBe(
			"import { getLocale } from '#locales/main.url.js';\nimport '#locales/main.loader.svelte.js';\nimport '#locales/js.loader.js';\n"
		);
		expect(read('src/lib/components/language-select.svelte')).toContain('from "#locales/data.js"');
		// Prose that names the alias is not a specifier.
		expect(read('src/routes/patterns/metadata.ts')).toContain('<code>$locales</code>');
		const vite = read('vite.config.ts');
		expect(vite).not.toContain('alias');
		expect(vite).toContain('\t\t\tadapter: adapter()\n\t\t})');

		const snapshot = ['package.json', 'vite.config.ts', 'src/hooks.server.ts'].map(read);
		const second = await migrateLocalesAlias(tmp);
		expect(second).toEqual({ changed: false, details: [], warnings: [] });
		expect(['package.json', 'vite.config.ts', 'src/hooks.server.ts'].map(read)).toEqual(snapshot);
	});

	test('keeps other aliases, and a quoted key works the same', async () => {
		project(
			VELABASE_VITE.replace(
				"\t\t\t\t$locales: 'src/locales'",
				"\t\t\t\t'$locales': './src/locales/',\n\t\t\t\t$content: 'src/content'"
			)
		);
		const outcome = await migrateLocalesAlias(tmp);
		expect(outcome.changed).toBe(true);
		const vite = read('vite.config.ts');
		expect(vite).toContain("alias: {\n\t\t\t\t$content: 'src/content'\n\t\t\t}");
		expect(vite).not.toContain('$locales');
	});

	test('an alias pointing elsewhere is left alone', async () => {
		const vite = VELABASE_VITE.replace("'src/locales'", "'src/i18n'");
		project(vite);
		expect((await migrateLocalesAlias(tmp)).changed).toBe(false);
		expect(read('vite.config.ts')).toBe(vite);
	});

	test('a different #locales/* already in package.json keeps the alias, with a warning', async () => {
		project();
		write(
			'package.json',
			`{\n\t"name": "app",\n\t"imports": {\n\t\t"#locales/*": "./i18n/*"\n\t}\n}\n`
		);
		write('src/a.ts', "import '$locales/data';\n");
		const outcome = await migrateLocalesAlias(tmp);
		expect(outcome.changed).toBe(false);
		expect(outcome.warnings[0]).toMatch(/alias\.\$locales was left in place/);
		expect(read('vite.config.ts')).toBe(VELABASE_VITE);
		expect(read('src/a.ts')).toBe("import '$locales/data';\n");
	});
});
