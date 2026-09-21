import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	mergeGitignore,
	mergeSvelteConfig,
	mergeTsconfig,
	mergeViteConfig
} from './config-merge.ts';

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-config-merge-'));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function write(name: string, content: string): string {
	const p = path.join(tmp, name);
	fs.writeFileSync(p, content);
	return p;
}

describe('mergeSvelteConfig', () => {
	test('injects runes block into a vanilla config', () => {
		const filePath = write(
			'svelte.config.js',
			`import adapter from '@sveltejs/adapter-auto';

/** @type {import('@sveltejs/kit').Config} */
const config = {
\tkit: {
\t\tadapter: adapter()
\t}
};

export default config;
`
		);
		const result = mergeSvelteConfig(tmp);
		expect(result.applied).toBe(true);
		const updated = fs.readFileSync(filePath, 'utf8');
		expect(updated).toMatch(/compilerOptions:\s*\{[\s\S]*runes/);
		expect(updated).toMatch(/kit: \{/);
	});

	test('skips when runes already configured', () => {
		const filePath = write(
			'svelte.config.js',
			`const config = {\n\tcompilerOptions: { runes: true }\n};`
		);
		const before = fs.readFileSync(filePath, 'utf8');
		const result = mergeSvelteConfig(tmp);
		expect(result.applied).toBe(false);
		expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
	});

	test('bails when compilerOptions already present without runes', () => {
		const filePath = write(
			'svelte.config.js',
			`const config = {\n\tcompilerOptions: { warningFilter: () => false }\n};`
		);
		const before = fs.readFileSync(filePath, 'utf8');
		const result = mergeSvelteConfig(tmp);
		expect(result.applied).toBe(false);
		expect(result.snippet).toBeDefined();
		expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
	});
});

describe('mergeSvelteConfig — vite.config target', () => {
	const VITE_INLINE = `import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit({})]
});
`;
	const VITE_BARE = `import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()]
});
`;

	test('injects runes into an existing sveltekit() inline arg', () => {
		write('vite.config.ts', VITE_INLINE);
		const result = mergeSvelteConfig(tmp);
		expect(result.applied).toBe(true);
		expect(result.file).toBe('vite.config.ts');
		const updated = fs.readFileSync(path.join(tmp, 'vite.config.ts'), 'utf8');
		expect(updated).toMatch(/compilerOptions:\s*\{[\s\S]*runes/);
	});

	// ts-morph formats to four spaces by default, which rewrote every line of
	// the tab-indented config `sv create` writes.
	test('keeps the file in its own indentation', () => {
		write('vite.config.ts', VITE_INLINE);
		mergeSvelteConfig(tmp);
		const tabbed = fs.readFileSync(path.join(tmp, 'vite.config.ts'), 'utf8');
		expect(tabbed).toContain('\n\tplugins: [');
		expect(tabbed).not.toMatch(/\n {2,}\S/);

		write('vite.config.ts', VITE_INLINE.replaceAll('\t', '  '));
		mergeSvelteConfig(tmp);
		const spaced = fs.readFileSync(path.join(tmp, 'vite.config.ts'), 'utf8');
		expect(spaced).toContain('\n  plugins: [');
		expect(spaced).not.toContain('\t');
		expect(spaced).not.toMatch(/\n {3}\S|\n {5}\S/);
	});

	test('creates an arg on a bare sveltekit() and injects runes', () => {
		write('vite.config.ts', VITE_BARE);
		const result = mergeSvelteConfig(tmp);
		expect(result.applied).toBe(true);
		const updated = fs.readFileSync(path.join(tmp, 'vite.config.ts'), 'utf8');
		expect(updated).toMatch(/sveltekit\(\{[\s\S]*runes/);
	});

	test('prefers vite-inline and leaves a leftover svelte.config untouched', () => {
		write('vite.config.ts', VITE_INLINE);
		const sveltePath = write(
			'svelte.config.js',
			`const config = {\n\tkit: {}\n};\nexport default config;\n`
		);
		const svelteBefore = fs.readFileSync(sveltePath, 'utf8');
		const result = mergeSvelteConfig(tmp);
		expect(result.applied).toBe(true);
		expect(result.file).toBe('vite.config.ts');
		expect(fs.readFileSync(sveltePath, 'utf8')).toBe(svelteBefore);
		expect(fs.readFileSync(path.join(tmp, 'vite.config.ts'), 'utf8')).toMatch(/runes/);
	});

	test('skips when runes already present in the sveltekit() arg', () => {
		write(
			'vite.config.ts',
			`import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit({ compilerOptions: { runes: true } })]
});
`
		);
		const before = fs.readFileSync(path.join(tmp, 'vite.config.ts'), 'utf8');
		const result = mergeSvelteConfig(tmp);
		expect(result.applied).toBe(false);
		expect(result.reason).toMatch(/already configured/);
		expect(fs.readFileSync(path.join(tmp, 'vite.config.ts'), 'utf8')).toBe(before);
	});
});

describe('mergeViteConfig', () => {
	test('adds tailwindcss import and plugin to a vanilla config', () => {
		const filePath = write(
			'vite.config.ts',
			`import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
\tplugins: [sveltekit()]
});
`
		);
		const result = mergeViteConfig(filePath);
		expect(result.applied).toBe(true);
		const updated = fs.readFileSync(filePath, 'utf8');
		expect(updated).toContain("import tailwindcss from '@tailwindcss/vite'");
		expect(updated).toContain('plugins: [tailwindcss(), sveltekit()]');
	});

	test('skips when tailwindcss already present', () => {
		const filePath = write(
			'vite.config.ts',
			`import tailwindcss from '@tailwindcss/vite';\nplugins: [tailwindcss()]\n`
		);
		const before = fs.readFileSync(filePath, 'utf8');
		const result = mergeViteConfig(filePath);
		expect(result.applied).toBe(false);
		expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
	});

	test('handles empty plugins array', () => {
		const filePath = write(
			'vite.config.ts',
			`import { defineConfig } from 'vite';\nexport default defineConfig({\n\tplugins: []\n});\n`
		);
		const result = mergeViteConfig(filePath);
		expect(result.applied).toBe(true);
		const updated = fs.readFileSync(filePath, 'utf8');
		expect(updated).toContain('plugins: [tailwindcss()]');
	});
});

describe('mergeTsconfig', () => {
	test('adds rewriteRelativeImportExtensions', () => {
		const filePath = write(
			'tsconfig.json',
			JSON.stringify(
				{
					extends: './.svelte-kit/tsconfig.json',
					compilerOptions: { allowJs: true, strict: true }
				},
				null,
				'\t'
			)
		);
		const result = mergeTsconfig(filePath);
		expect(result.applied).toBe(true);
		const updated = fs.readFileSync(filePath, 'utf8');
		expect(updated).toContain('"rewriteRelativeImportExtensions": true');
	});

	test('skips when already set', () => {
		const filePath = write(
			'tsconfig.json',
			JSON.stringify({ compilerOptions: { rewriteRelativeImportExtensions: true } })
		);
		const result = mergeTsconfig(filePath);
		expect(result.applied).toBe(false);
	});
});

describe('mergeGitignore', () => {
	test('adds missing env entries', () => {
		const filePath = write('.gitignore', 'node_modules\n/build\n');
		const result = mergeGitignore(filePath);
		expect(result.applied).toBe(true);
		const updated = fs.readFileSync(filePath, 'utf8');
		expect(updated).toContain('.env.*');
		expect(updated).toContain('!.env.example');
	});

	test('keeps the database out of git but not the fixtures, seeds and hooks', () => {
		const filePath = write('.gitignore', 'node_modules\n');
		mergeGitignore(filePath);
		const updated = fs.readFileSync(filePath, 'utf8');
		expect(updated).toContain('/data/*\n!/data/fixtures\n!/data/seeds\n!/data/hooks\n/backups');
	});

	test('creates gitignore when missing', () => {
		const filePath = path.join(tmp, '.gitignore');
		const result = mergeGitignore(filePath);
		expect(result.applied).toBe(true);
		expect(fs.existsSync(filePath)).toBe(true);
	});

	test('no-op when all entries present', () => {
		const filePath = write(
			'.gitignore',
			'.env\n.env.*\n!.env.example\n!.env.test\nvite.config.js.timestamp-*\nvite.config.ts.timestamp-*\n/data/*\n!/data/fixtures\n!/data/seeds\n!/data/hooks\n/backups\n'
		);
		const before = fs.readFileSync(filePath, 'utf8');
		const result = mergeGitignore(filePath);
		expect(result.applied).toBe(false);
		expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
	});
});
