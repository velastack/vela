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

// What `sv create --template minimal` writes: sv 1.0.1's vite.config.ts.
const SV_VITE_CONFIG = `import adapter from '@sveltejs/adapter-auto';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\\\]/).includes('node_modules') ? undefined : true
			},

			// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
			// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
			// See https://svelte.dev/docs/kit/adapters for more information about adapters.
			adapter: adapter()
		})
	]
});
`;

const BARE_VITE_CONFIG = `import { sveltekit } from '@sveltejs/kit/vite';
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
			...(process.env.VELA_ORIGIN ? { paths: { origin: process.env.VELA_ORIGIN } } : {})
		})
	]
});
`;

/** A vite.config whose sveltekit() argument is `kit`, with `imports` above it. */
function viteConfig(imports: string, kit: string): string {
	return `${imports}import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit(${kit})] };\n`;
}

describe('detectAdapter', () => {
	test('reads the sv layout: adapter-auto inline in sveltekit()', () => {
		write('vite.config.ts', SV_VITE_CONFIG);
		expect(detectAdapter(tmp)).toMatchObject({
			kind: 'auto',
			file: path.join(tmp, 'vite.config.ts'),
			specifier: '@sveltejs/adapter-auto'
		});
	});

	test('a svelte.config is a SvelteKit 2 project, refused with the migrate command', () => {
		write('vite.config.ts', INLINE_VITE_CONFIG);
		write(
			'svelte.config.js',
			`import adapter from '@sveltejs/adapter-node';\nexport default { kit: { adapter: adapter() } };\n`
		);
		expect(() => detectAdapter(tmp)).toThrow(AdapterError);
		expect(() => detectAdapter(tmp)).toThrow(/svelte\.config\.js found/);
		try {
			detectAdapter(tmp);
		} catch (err) {
			expect((err as AdapterError).snippet).toBe('npx vela@^0.15 migrate sveltekit-3');
		}
	});

	test('classifies by module specifier, not by the local name', () => {
		write(
			'vite.config.ts',
			viteConfig(`import adapter from '@sveltejs/adapter-vercel';\n`, '{ adapter: adapter() }')
		);
		expect(detectAdapter(tmp).kind).toBe('other');
		write(
			'vite.config.ts',
			viteConfig(`import node from '@sveltejs/adapter-node';\n`, '{ adapter: node() }')
		);
		expect(detectAdapter(tmp).kind).toBe('node');
	});

	test('a conditional adapter is a decision vela does not touch', () => {
		write(
			'vite.config.ts',
			viteConfig(
				`import node from '@sveltejs/adapter-node';\nimport auto from '@sveltejs/adapter-auto';\n`,
				'{ adapter: process.env.X ? node() : auto() }'
			)
		);
		expect(detectAdapter(tmp).kind).toBe('other');
	});

	test('no adapter property is none', () => {
		write('vite.config.ts', viteConfig('', '{}'));
		expect(detectAdapter(tmp).kind).toBe('none');
	});

	test('a non-object sveltekit() argument cannot be inspected', () => {
		write(
			'vite.config.ts',
			`import { sveltekit } from '@sveltejs/kit/vite';\nconst kit = {};\nexport default { plugins: [sveltekit(kit)] };\n`
		);
		expect(() => detectAdapter(tmp)).toThrow(AdapterError);
	});

	test('no vite config at all is refused', () => {
		expect(() => detectAdapter(tmp)).toThrow(/No vite.config/);
	});
});

describe('ensureNodeAdapter', () => {
	test('switches the sv layout to adapter-node and drops the adapter-auto boilerplate', async () => {
		write('vite.config.ts', SV_VITE_CONFIG);
		pkg({ '@sveltejs/adapter-auto': '^8.0.0', '@sveltejs/kit': '^3.0.0' });

		const outcome = await ensureNodeAdapter(tmp, { install: false });

		expect(outcome).toMatchObject({
			previous: 'auto',
			configFile: 'vite.config.ts',
			packageJsonChanged: true,
			removedDeps: ['@sveltejs/adapter-auto']
		});
		const updated = read('vite.config.ts');
		expect(updated).toContain(`import adapter from '@sveltejs/adapter-node';`);
		expect(updated).not.toContain('adapter-auto');
		// The boilerplate goes along with the blank line above it; the runes
		// comment the author might keep stays, and nothing is reformatted.
		expect(updated).toBe(`import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	]
});
`);
		expect(devDeps()).toEqual({
			'@sveltejs/adapter-node': ADAPTER_NODE_RANGE,
			'@sveltejs/kit': '^3.0.0'
		});
	});

	test('switches vela’s inline vite config', async () => {
		write('vite.config.ts', INLINE_VITE_CONFIG);
		pkg({ '@sveltejs/adapter-auto': '^8.0.0' });

		const outcome = await ensureNodeAdapter(tmp, { install: false });

		expect(outcome.configFile).toBe('vite.config.ts');
		expect(read('vite.config.ts')).toBe(
			INLINE_VITE_CONFIG.replace('@sveltejs/adapter-auto', '@sveltejs/adapter-node')
		);
	});

	test('refuses a svelte.config project before touching anything', async () => {
		write('vite.config.ts', SV_VITE_CONFIG);
		write('svelte.config.js', `export default { kit: {} };\n`);
		pkg({ '@sveltejs/adapter-auto': '^7.0.1' });

		await expect(ensureNodeAdapter(tmp, { install: false })).rejects.toThrow(
			/svelte\.config\.js found/
		);
		expect(read('vite.config.ts')).toBe(SV_VITE_CONFIG);
		expect(devDeps()).toEqual({ '@sveltejs/adapter-auto': '^7.0.1' });
	});

	test('a project already on adapter-node is left byte-identical', async () => {
		const config = SV_VITE_CONFIG.replace('adapter-auto', 'adapter-node');
		write('vite.config.ts', config);
		pkg({ '@sveltejs/adapter-node': '^6.0.0' });

		const outcome = await ensureNodeAdapter(tmp, { install: false });

		expect(outcome).toMatchObject({ previous: 'node', packageJsonChanged: false });
		expect(outcome.configFile).toBeUndefined();
		expect(read('vite.config.ts')).toBe(config);
		expect(devDeps()).toEqual({ '@sveltejs/adapter-node': '^6.0.0' });
	});

	test('adapter-node configured but not installed gets the devDependency', async () => {
		write('vite.config.ts', SV_VITE_CONFIG.replace('adapter-auto', 'adapter-node'));
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
		pkg({ '@sveltejs/adapter-static': '^4.0.0' });

		await expect(ensureNodeAdapter(tmp, { install: false })).rejects.toMatchObject({
			name: 'AdapterError',
			message: expect.stringContaining('adapter-static'),
			snippet: expect.stringContaining(`import adapter from '@sveltejs/adapter-node'`)
		});
		expect(read('vite.config.ts')).toBe(config);
		expect(devDeps()).toEqual({ '@sveltejs/adapter-static': '^4.0.0' });
	});

	test("another platform's adapter is refused too", async () => {
		write(
			'vite.config.ts',
			viteConfig(`import adapter from '@sveltejs/adapter-vercel';\n`, '{ adapter: adapter() }')
		);
		await expect(ensureNodeAdapter(tmp, { install: false })).rejects.toThrow(/adapter-vercel/);
	});

	test('adds an adapter to an inline sveltekit({}) arg at the top level', async () => {
		write('vite.config.ts', viteConfig('', '{ compilerOptions: { runes: true } }'));
		pkg({});
		const outcome = await ensureNodeAdapter(tmp, { install: false });
		expect(outcome.previous).toBe('none');
		const updated = read('vite.config.ts');
		expect(updated).toContain(`import adapter from '@sveltejs/adapter-node';`);
		expect(updated).toMatch(/sveltekit\(\{[^}]*runes: true[^}]*\},\s*adapter: adapter\(\)\s*\}\)/s);
		expect(detectAdapter(tmp)).toMatchObject({ kind: 'node' });
	});

	test('a bare sveltekit() gets an argument', async () => {
		write('vite.config.ts', BARE_VITE_CONFIG);
		pkg({});
		await ensureNodeAdapter(tmp, { install: false });
		expect(read('vite.config.ts')).toContain('adapter: adapter()');
		expect(detectAdapter(tmp)).toMatchObject({ kind: 'node' });
	});

	test('does not shadow a different `adapter` binding', async () => {
		write(
			'vite.config.ts',
			viteConfig(`import adapter from 'some-other-thing';\n`, '{ paths: { base: adapter } }')
		);
		await expect(ensureNodeAdapter(tmp, { install: false })).rejects.toThrow(/already binds/);
	});
});

describe('adoptNodeAdapter', () => {
	test('drops adapter-auto from either bucket and adds adapter-node once', () => {
		const p = {
			dependencies: { '@sveltejs/adapter-auto': '^8.0.0' },
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
		const p = { dependencies: { '@sveltejs/adapter-node': '^6.0.0' } };
		expect(adoptNodeAdapter(p)).toEqual({ changed: false, removed: [] });
	});

	test('writes the adapter-node major SvelteKit 3 needs', () => {
		expect(ADAPTER_NODE_RANGE).toBe('^6.0.0');
	});
});
