import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { detectAdapter, ensureNodeAdapter } from './adapter.ts';
import { buildStack, DevOnlyEnvError } from './build-stack.ts';
import { readAtBuildTime } from './env-command.ts';
import { copyKit2Fixture, snapshot } from './kit2-fixture.ts';
import { kitMajor } from './kit-version.ts';
import { staticEnv } from './static-env.ts';
import { ssrExternalPreflight } from '../commands/deploy.ts';

/**
 * What `vela deploy` and `vela env set` make of a plain `sv create` SvelteKit 2
 * project that is already on adapter-node: it deploys as it is, by Kit 2's
 * rules, and nothing in it is rewritten.
 */

let root: string;

beforeEach(() => {
	root = copyKit2Fixture('vanilla');
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
	const file = path.join(root, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function editJson(rel: string, edit: (json: any) => void): void {
	const file = path.join(root, rel);
	const json = JSON.parse(fs.readFileSync(file, 'utf8'));
	edit(json);
	fs.writeFileSync(file, JSON.stringify(json, null, '\t') + '\n');
}

describe('a vanilla SvelteKit 2 project on adapter-node', () => {
	test('is read as SvelteKit 2, with its adapter taken from svelte.config.js', () => {
		expect(kitMajor(root)).toBe(2);
		expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(true);
		expect(detectAdapter(root)).toEqual({
			kind: 'node',
			file: path.join(root, 'svelte.config.js'),
			specifier: '@sveltejs/adapter-node'
		});
	});

	test('the deploy preflight leaves every file as it was', async () => {
		const before = snapshot(root);
		const outcome = await ensureNodeAdapter(root, { install: false });
		expect(outcome).toEqual({ previous: 'node', removedDeps: [], packageJsonChanged: false });
		expect(() => ssrExternalPreflight(root)).not.toThrow();
		expect(snapshot(root)).toEqual(before);
	});

	test('a devDependency in ssr.external is not a problem: adapter-node 5 bundles it', () => {
		write(
			'vite.config.ts',
			`import { sveltekit } from '@sveltejs/kit/vite';\nimport { defineConfig } from 'vite';\n\n` +
				`export default defineConfig({\n\tplugins: [sveltekit()],\n\tssr: { external: ['svelte-check'] }\n});\n`
		);
		expect(() => ssrExternalPreflight(root)).not.toThrow();
	});

	test('build-time variables follow the Kit 2 rule: the $env/static import path', () => {
		write(
			'src/routes/+page.server.ts',
			`import { GREETING } from '$env/static/private';\nimport { env } from '$env/dynamic/private';\n\n` +
				`export function load() {\n\treturn { greeting: GREETING, mode: env.MODE };\n}\n`
		);
		const fixed = staticEnv(root);
		expect(fixed.rule).toBe('imports');
		expect([...fixed.names]).toEqual(['GREETING']);
		expect(readAtBuildTime(root, ['GREETING', 'MODE'])).toEqual({
			baked: ['GREETING'],
			how: 'imported from $env/static'
		});

		write('.env', 'GREETING=hi\nMODE=dev\n');
		expect(() => buildStack(root, { stack: {}, derived: {}, tunnel: true })).toThrow(
			DevOnlyEnvError
		);
		expect(() => buildStack(root, { stack: {}, derived: {}, tunnel: true })).toThrow(
			/GREETING is imported from \$env\/static but set only in your \.env[^]*or remove the import/
		);
		expect(buildStack(root, { stack: { GREETING: 'hello' }, derived: {}, tunnel: true })).toEqual({
			env: { GREETING: 'hello', MODE: '' },
			blanked: ['MODE']
		});
	});

	test('on adapter-auto instead, the switch is refused and nothing is written', async () => {
		const config = fs
			.readFileSync(path.join(root, 'svelte.config.js'), 'utf8')
			.replace('@sveltejs/adapter-node', '@sveltejs/adapter-auto');
		write('svelte.config.js', config);
		editJson('package.json', (pkg) => {
			delete pkg.devDependencies['@sveltejs/adapter-node'];
			pkg.devDependencies['@sveltejs/adapter-auto'] = '^7.0.1';
		});
		const before = snapshot(root);

		expect(detectAdapter(root)).toMatchObject({ kind: 'auto' });
		await expect(ensureNodeAdapter(root, { install: false })).rejects.toThrow(
			/this is a SvelteKit 2 project[^]*Add it to svelte\.config\.js yourself, or migrate/
		);
		expect(snapshot(root)).toEqual(before);
	});
});
