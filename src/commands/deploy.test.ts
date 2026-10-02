import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { nodeVersionAtLeast, ssrExternalPreflight } from './deploy.ts';

describe('nodeVersionAtLeast', () => {
	test('compares the minor within the same major', () => {
		expect(nodeVersionAtLeast('v22.16.0', 22, 17)).toBe(false);
		expect(nodeVersionAtLeast('v22.17.0', 22, 17)).toBe(true);
		expect(nodeVersionAtLeast('v22.20.1', 22, 17)).toBe(true);
	});

	test('a later major passes whatever its minor', () => {
		expect(nodeVersionAtLeast('v23.0.0', 22, 17)).toBe(true);
		expect(nodeVersionAtLeast('v24.1.0', 22, 17)).toBe(true);
	});

	test('an earlier major fails whatever its minor', () => {
		expect(nodeVersionAtLeast('v20.19.5', 22, 17)).toBe(false);
	});

	test('reads `node -v` output as it arrives', () => {
		expect(nodeVersionAtLeast('v24.0.0\n', 22, 17)).toBe(true);
		expect(nodeVersionAtLeast('22.17.0', 22, 17)).toBe(true);
	});

	test('no Node, or nothing readable, is not enough', () => {
		expect(nodeVersionAtLeast('', 22, 17)).toBe(false);
		expect(nodeVersionAtLeast('bash: node: command not found', 22, 17)).toBe(false);
	});
});

describe('ssrExternalPreflight', () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	function project(
		adapter: string,
		external: string,
		patterns: 'dependencies' | 'devDependencies'
	) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-deploy-ssr-'));
		dirs.push(dir);
		fs.writeFileSync(
			path.join(dir, 'vite.config.ts'),
			`import adapter from '${adapter}';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit({ adapter: adapter() })],
	ssr: { external: ${external} }
});
`
		);
		const pkg = {
			name: 'app',
			dependencies: { 'pocketbase-sveltekit': '^0.28.1' },
			devDependencies: { '@sveltejs/kit': '^3.0.0', [adapter]: '^6.0.0' }
		} as Record<string, Record<string, string> | string>;
		(pkg[patterns] as Record<string, string>)['@velastack/patterns'] = '^0.4.0';
		fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
		return dir;
	}

	const LIST = `['@velastack/patterns', 'pocketbase-sveltekit']`;

	test('adapter-node with a devDependency in ssr.external fails, naming it and the fix', () => {
		const dir = project('@sveltejs/adapter-node', LIST, 'devDependencies');
		expect(() => ssrExternalPreflight(dir)).toThrow(/@velastack\/patterns in ssr\.external/);
		expect(() => ssrExternalPreflight(dir)).toThrow(
			'Move it to dependencies, or drop it from ssr.external.'
		);
	});

	test('passes once the package is a dependency', () => {
		const dir = project('@sveltejs/adapter-node', LIST, 'dependencies');
		expect(() => ssrExternalPreflight(dir)).not.toThrow();
	});

	test('adapter-static has no server to miss it', () => {
		const dir = project('@sveltejs/adapter-static', LIST, 'devDependencies');
		expect(() => ssrExternalPreflight(dir)).not.toThrow();
	});

	test('`ssr.external: true` does not fail: adapter-node 6 bundles everything regardless', () => {
		const dir = project('@sveltejs/adapter-node', 'true', 'devDependencies');
		expect(() => ssrExternalPreflight(dir)).not.toThrow();
	});

	test('a list vela cannot read passes', () => {
		const dir = project('@sveltejs/adapter-node', `[...process.env.X]`, 'devDependencies');
		expect(() => ssrExternalPreflight(dir)).not.toThrow();
	});
});
