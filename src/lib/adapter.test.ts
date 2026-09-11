import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	ADAPTER_NODE_RANGE,
	AdapterError,
	adoptNodeAdapter,
	detectAdapter,
	ensureNodeAdapter
} from './adapter.ts';

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-adapter-'));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function write(name: string, content: string): string {
	const p = path.join(tmp, name);
	fs.writeFileSync(p, content);
	return p;
}

function read(name: string): string {
	return fs.readFileSync(path.join(tmp, name), 'utf8');
}

function pkg(devDependencies: Record<string, string>) {
	write('package.json', JSON.stringify({ name: 'app', devDependencies }, null, '\t') + '\n');
}

function devDeps(): Record<string, string> {
	return JSON.parse(read('package.json')).devDependencies;
}

// What `sv create --template minimal` writes today.
const SV_SVELTE_CONFIG = `import adapter from '@sveltejs/adapter-auto';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
		// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
		// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
		// See https://svelte.dev/docs/kit/adapters for more information about adapters.
		adapter: adapter()
	}
};

export default config;
`;

const SV_VITE_CONFIG = `import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()]
});
`;

// vela's own minimal template: kit config inline in vite.config.
const INLINE_VITE_CONFIG = `import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-auto';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			...(process.env.VELA_ORIGIN ? { prerender: { origin: process.env.VELA_ORIGIN } } : {})
		})
	]
});
`;

describe('detectAdapter', () => {
	test('reads the sv layout: adapter-auto under kit in svelte.config.js', () => {
		write('svelte.config.js', SV_SVELTE_CONFIG);
		write('vite.config.ts', SV_VITE_CONFIG);
		expect(detectAdapter(tmp)).toMatchObject({
			kind: 'auto',
			container: 'svelte-config',
			specifier: '@sveltejs/adapter-auto'
		});
	});

	test('an inline sveltekit() arg outranks a leftover svelte.config', () => {
		write('vite.config.ts', INLINE_VITE_CONFIG);
		write('svelte.config.js', SV_SVELTE_CONFIG.replace('adapter-auto', 'adapter-static'));
		expect(detectAdapter(tmp)).toMatchObject({ kind: 'auto', container: 'vite-inline' });
	});

	test('classifies by module specifier, not by the local name', () => {
		write(
			'svelte.config.js',
			`import adapter from '@sveltejs/adapter-vercel';\nexport default { kit: { adapter: adapter() } };\n`
		);
		expect(detectAdapter(tmp).kind).toBe('other');
		write(
			'svelte.config.js',
			`import node from '@sveltejs/adapter-node';\nexport default { kit: { adapter: node() } };\n`
		);
		expect(detectAdapter(tmp).kind).toBe('node');
	});

	test('a conditional adapter is a decision vela does not touch', () => {
		write(
			'svelte.config.js',
			`import node from '@sveltejs/adapter-node';\nimport auto from '@sveltejs/adapter-auto';\n` +
				`export default { kit: { adapter: process.env.X ? node() : auto() } };\n`
		);
		expect(detectAdapter(tmp).kind).toBe('other');
	});

	test('no adapter property is none', () => {
		write('svelte.config.js', `export default { kit: {} };\n`);
		expect(detectAdapter(tmp).kind).toBe('none');
	});

	test('a non-object sveltekit() argument cannot be inspected', () => {
		write(
			'vite.config.ts',
			`import { sveltekit } from '@sveltejs/kit/vite';\nconst kit = {};\nexport default { plugins: [sveltekit(kit)] };\n`
		);
		expect(() => detectAdapter(tmp)).toThrow(AdapterError);
	});

	test('a CommonJS svelte.config is refused', () => {
		write('svelte.config.cjs', `module.exports = { kit: {} };\n`);
		expect(() => detectAdapter(tmp)).toThrow(/CommonJS/);
	});
});

describe('ensureNodeAdapter', () => {
	test('switches the sv layout to adapter-node and drops the adapter-auto boilerplate', async () => {
		write('svelte.config.js', SV_SVELTE_CONFIG);
		write('vite.config.ts', SV_VITE_CONFIG);
		pkg({ '@sveltejs/adapter-auto': '^7.0.1', '@sveltejs/kit': '^2.63.0' });

		const outcome = await ensureNodeAdapter(tmp, { install: false });

		expect(outcome).toMatchObject({
			previous: 'auto',
			configFile: 'svelte.config.js',
			packageJsonChanged: true,
			removedDeps: ['@sveltejs/adapter-auto']
		});
		const updated = read('svelte.config.js');
		expect(updated).toContain(`import adapter from '@sveltejs/adapter-node';`);
		expect(updated).not.toContain('adapter-auto');
		expect(updated).toContain(`\tkit: {\n\t\tadapter: adapter()\n\t}`);
		// Everything the author might have written stays.
		expect(updated).toContain('// Consult https://svelte.dev/docs/kit/integrations');
		expect(updated).toContain(`/** @type {import('@sveltejs/kit').Config} */`);
		// The vite config is not touched: an inline arg would make Kit ignore svelte.config.
		expect(read('vite.config.ts')).toBe(SV_VITE_CONFIG);
		expect(devDeps()).toEqual({
			'@sveltejs/adapter-node': ADAPTER_NODE_RANGE,
			'@sveltejs/kit': '^2.63.0'
		});
	});

	test('switches an inline vite config and leaves a leftover svelte.config alone', async () => {
		write('vite.config.ts', INLINE_VITE_CONFIG);
		write('svelte.config.js', SV_SVELTE_CONFIG);
		pkg({ '@sveltejs/adapter-auto': '^7.0.1' });

		const outcome = await ensureNodeAdapter(tmp, { install: false });

		expect(outcome.configFile).toBe('vite.config.ts');
		expect(read('vite.config.ts')).toBe(
			INLINE_VITE_CONFIG.replace('@sveltejs/adapter-auto', '@sveltejs/adapter-node')
		);
		expect(read('svelte.config.js')).toBe(SV_SVELTE_CONFIG);
	});

	test('a project already on adapter-node is left byte-identical', async () => {
		const config = SV_SVELTE_CONFIG.replace('adapter-auto', 'adapter-node');
		write('svelte.config.js', config);
		pkg({ '@sveltejs/adapter-node': '^5.0.0' });

		const outcome = await ensureNodeAdapter(tmp, { install: false });

		expect(outcome).toMatchObject({ previous: 'node', packageJsonChanged: false });
		expect(outcome.configFile).toBeUndefined();
		expect(read('svelte.config.js')).toBe(config);
		expect(devDeps()).toEqual({ '@sveltejs/adapter-node': '^5.0.0' });
	});

	test('adapter-node configured but not installed gets the devDependency', async () => {
		write('svelte.config.js', SV_SVELTE_CONFIG.replace('adapter-auto', 'adapter-node'));
		pkg({});
		const outcome = await ensureNodeAdapter(tmp, { install: false });
		expect(outcome).toMatchObject({ previous: 'node', packageJsonChanged: true });
		expect(devDeps()).toEqual({ '@sveltejs/adapter-node': ADAPTER_NODE_RANGE });
	});

	test('adapter-static is a choice and is refused with the snippet', async () => {
		const config = INLINE_VITE_CONFIG.replace('adapter-auto', 'adapter-static').replace(
			'adapter: adapter()',
			`adapter: adapter({ fallback: '200.html' })`
		);
		write('vite.config.ts', config);
		pkg({ '@sveltejs/adapter-static': '^3.0.10' });

		await expect(ensureNodeAdapter(tmp, { install: false })).rejects.toMatchObject({
			name: 'AdapterError',
			message: expect.stringContaining('adapter-static'),
			snippet: expect.stringContaining(`import adapter from '@sveltejs/adapter-node'`)
		});
		expect(read('vite.config.ts')).toBe(config);
		expect(devDeps()).toEqual({ '@sveltejs/adapter-static': '^3.0.10' });
	});

	test("another platform's adapter is refused too", async () => {
		write(
			'svelte.config.js',
			`import adapter from '@sveltejs/adapter-vercel';\nexport default { kit: { adapter: adapter() } };\n`
		);
		await expect(ensureNodeAdapter(tmp, { install: false })).rejects.toThrow(/adapter-vercel/);
	});

	test('adds an adapter to a svelte.config that has none, under kit', async () => {
		write(
			'svelte.config.js',
			`/** @type {import('@sveltejs/kit').Config} */\nexport default {\n\tkit: {}\n};\n`
		);
		pkg({});
		const outcome = await ensureNodeAdapter(tmp, { install: false });
		expect(outcome.previous).toBe('none');
		const updated = read('svelte.config.js');
		expect(updated).toContain(`import adapter from '@sveltejs/adapter-node';`);
		expect(updated).toMatch(/kit: \{\s*adapter: adapter\(\)\s*\}/);
		expect(detectAdapter(tmp).kind).toBe('node');
	});

	test('adds an adapter to an inline sveltekit({}) arg at the top level', async () => {
		write(
			'vite.config.ts',
			`import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit({ compilerOptions: { runes: true } })] };\n`
		);
		pkg({});
		await ensureNodeAdapter(tmp, { install: false });
		const updated = read('vite.config.ts');
		expect(updated).toMatch(/sveltekit\(\{[^}]*runes: true[^}]*\},\s*adapter: adapter\(\)\s*\}\)/s);
		expect(detectAdapter(tmp)).toMatchObject({ kind: 'node', container: 'vite-inline' });
	});

	test('a bare sveltekit() with no svelte.config gets an argument', async () => {
		write('vite.config.ts', SV_VITE_CONFIG);
		pkg({});
		await ensureNodeAdapter(tmp, { install: false });
		expect(read('vite.config.ts')).toContain('adapter: adapter()');
		expect(detectAdapter(tmp)).toMatchObject({ kind: 'node', container: 'vite-inline' });
	});

	test('does not shadow a different `adapter` binding', async () => {
		write(
			'svelte.config.js',
			`import adapter from 'some-other-thing';\nexport default { kit: { paths: { base: adapter } } };\n`
		);
		await expect(ensureNodeAdapter(tmp, { install: false })).rejects.toThrow(/already binds/);
	});
});

describe('adoptNodeAdapter', () => {
	test('drops adapter-auto from either bucket and adds adapter-node once', () => {
		const p = {
			dependencies: { '@sveltejs/adapter-auto': '^7.0.1' },
			devDependencies: { zod: '^4.0.0' }
		};
		expect(adoptNodeAdapter(p)).toEqual({ changed: true, removed: ['@sveltejs/adapter-auto'] });
		expect(p.dependencies).toEqual({});
		expect(p.devDependencies).toEqual({
			'@sveltejs/adapter-node': ADAPTER_NODE_RANGE,
			zod: '^4.0.0'
		});
	});

	test('nothing to do when adapter-node is a dependency already', () => {
		const p = { dependencies: { '@sveltejs/adapter-node': '^5.0.0' } };
		expect(adoptNodeAdapter(p)).toEqual({ changed: false, removed: [] });
	});
});
