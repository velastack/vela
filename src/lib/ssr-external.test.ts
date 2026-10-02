import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	moveToDependencies,
	packageNameOf,
	ssrExternalAllNotice,
	ssrExternalNotInDependencies,
	ssrExternalProblem
} from './ssr-external.ts';

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-ssr-external-'));
	fs.writeFileSync(
		path.join(tmp, 'package.json'),
		JSON.stringify({
			name: 'app',
			dependencies: { 'pocketbase-sveltekit': '^0.28.1', 'better-sqlite3': '^13.0.3' },
			devDependencies: {
				'@velastack/patterns': '^0.4.0',
				'@sveltejs/kit': '^3.0.0',
				'@sveltejs/adapter-node': '^6.0.0'
			}
		})
	);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** A vite.config.ts whose default export is `config` (source text). */
function viteConfig(config: string, preamble = ''): void {
	fs.writeFileSync(
		path.join(tmp, 'vite.config.ts'),
		`import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
${preamble}
export default ${config};
`
	);
}

const plugins = `plugins: [sveltekit({ adapter: adapter() })]`;

describe('ssrExternalNotInDependencies', () => {
	test('a devDependency in a literal list is missing; a dependency is not', () => {
		viteConfig(
			`defineConfig({ ${plugins}, ssr: { external: ['@velastack/patterns', 'pocketbase-sveltekit'] } })`
		);
		expect(ssrExternalNotInDependencies(tmp)).toEqual({
			kind: 'list',
			file: 'vite.config.ts',
			entries: ['@velastack/patterns', 'pocketbase-sveltekit'],
			missing: ['@velastack/patterns']
		});
	});

	test('only dependencies: nothing missing', () => {
		viteConfig(`defineConfig({ ${plugins}, ssr: { external: ['better-sqlite3'] } })`);
		expect(ssrExternalNotInDependencies(tmp)).toMatchObject({ kind: 'list', missing: [] });
	});

	test('Node builtins, bare or `node:`, are never missing', () => {
		viteConfig(`defineConfig({ ${plugins}, ssr: { external: ['fs', 'node:path', 'crypto'] } })`);
		expect(ssrExternalNotInDependencies(tmp)).toMatchObject({ kind: 'list', missing: [] });
	});

	test('a package the project does not list at all is left out', () => {
		viteConfig(`defineConfig({ ${plugins}, ssr: { external: ['some-transitive-dep'] } })`);
		expect(ssrExternalNotInDependencies(tmp)).toMatchObject({ kind: 'list', missing: [] });
	});

	test('a subpath counts as its package', () => {
		viteConfig(`defineConfig({ ${plugins}, ssr: { external: ['@velastack/patterns/server'] } })`);
		expect(ssrExternalNotInDependencies(tmp)).toMatchObject({
			missing: ['@velastack/patterns']
		});
	});

	test('a plain object export and a const are read too', () => {
		viteConfig(
			`config`,
			`const config = { ${plugins}, ssr: { external: ['@velastack/patterns'] } };`
		);
		expect(ssrExternalNotInDependencies(tmp)).toMatchObject({
			missing: ['@velastack/patterns']
		});
	});

	test('`true` is its own case', () => {
		viteConfig(`defineConfig({ ${plugins}, ssr: { external: true } })`);
		expect(ssrExternalNotInDependencies(tmp)).toEqual({ kind: 'all', file: 'vite.config.ts' });
	});

	test('a non-literal is unknown, not a throw', () => {
		viteConfig(
			`defineConfig({ ${plugins}, ssr: { external: [...externals, '@velastack/patterns'] } })`,
			`import { externals } from './externals.js';`
		);
		expect(ssrExternalNotInDependencies(tmp)).toMatchObject({
			kind: 'unknown',
			file: 'vite.config.ts'
		});

		viteConfig(
			`defineConfig({ ${plugins}, ssr: { external: externals } })`,
			`import { externals } from './externals.js';`
		);
		expect(ssrExternalNotInDependencies(tmp).kind).toBe('unknown');

		viteConfig(`defineConfig(() => ({ ${plugins}, ssr: { external: ['x'] } }))`);
		expect(ssrExternalNotInDependencies(tmp).kind).toBe('unknown');
	});

	test('no ssr, no ssr.external, or no vite config: none', () => {
		viteConfig(`defineConfig({ ${plugins} })`);
		expect(ssrExternalNotInDependencies(tmp)).toEqual({ kind: 'none' });
		viteConfig(`defineConfig({ ${plugins}, ssr: { noExternal: ['x'] } })`);
		expect(ssrExternalNotInDependencies(tmp)).toEqual({ kind: 'none' });
		fs.rmSync(path.join(tmp, 'vite.config.ts'));
		expect(ssrExternalNotInDependencies(tmp)).toEqual({ kind: 'none' });
	});

	test('a config that does not parse is unknown or none, never a throw', () => {
		fs.writeFileSync(path.join(tmp, 'vite.config.ts'), 'export default defineConfig({ ssr: {');
		expect(() => ssrExternalNotInDependencies(tmp)).not.toThrow();
	});
});

describe('packageNameOf', () => {
	test('scoped and unscoped subpaths', () => {
		expect(packageNameOf('@a/b/c')).toBe('@a/b');
		expect(packageNameOf('a/b')).toBe('a');
		expect(packageNameOf('a')).toBe('a');
	});
});

describe('moveToDependencies', () => {
	test('keeps the range, sorts dependencies, and is a no-op the second time', () => {
		const pkg = {
			dependencies: { zod: '^4.0.0' },
			devDependencies: { '@velastack/patterns': '^0.4.0', vite: '^8.0.0' }
		};
		expect(moveToDependencies(pkg, ['@velastack/patterns'])).toEqual(['@velastack/patterns']);
		expect(pkg).toEqual({
			dependencies: { '@velastack/patterns': '^0.4.0', zod: '^4.0.0' },
			devDependencies: { vite: '^8.0.0' }
		});
		expect(Object.keys(pkg.dependencies)).toEqual(['@velastack/patterns', 'zod']);
		expect(moveToDependencies(pkg, ['@velastack/patterns'])).toEqual([]);
	});
});

describe('ssrExternalProblem', () => {
	test('names the packages and both fixes', () => {
		const message = ssrExternalProblem({
			kind: 'list',
			file: 'vite.config.ts',
			entries: ['@velastack/patterns'],
			missing: ['@velastack/patterns']
		});
		expect(message).toContain('@velastack/patterns');
		expect(message).toContain('ERR_MODULE_NOT_FOUND');
		expect(message).toContain('Move it to dependencies, or drop it from ssr.external.');
	});

	test('nothing missing, unknown and none are not problems', () => {
		expect(
			ssrExternalProblem({ kind: 'list', file: 'vite.config.ts', entries: ['x'], missing: [] })
		).toBeNull();
		expect(ssrExternalProblem({ kind: 'unknown', file: 'vite.config.ts', reason: '' })).toBeNull();
		expect(ssrExternalProblem({ kind: 'none' })).toBeNull();
	});

	test('`true` is a notice, not a problem: adapter-node 6 bundles everything anyway', () => {
		const all = { kind: 'all', file: 'vite.config.ts' } as const;
		expect(ssrExternalProblem(all)).toBeNull();
		expect(ssrExternalAllNotice(all)).toContain('ssr.external: true');
		expect(
			ssrExternalAllNotice({ kind: 'list', file: 'vite.config.ts', entries: [], missing: [] })
		).toBeNull();
	});
});
