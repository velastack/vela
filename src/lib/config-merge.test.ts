import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	captureSvelteConfig,
	mergeGitignore,
	mergeOriginConfig,
	ORIGIN_COMMENT,
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

function read(name: string): string {
	return fs.readFileSync(path.join(tmp, name), 'utf8');
}

describe('mergeSvelteConfig — svelte.config', () => {
	test('a svelte.config is a SvelteKit 2 project: the outcome is the migrate command', () => {
		write(
			'vite.config.ts',
			`import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit({})] };\n`
		);
		const sveltePath = write(
			'svelte.config.js',
			`const config = {\n\tkit: {}\n};\nexport default config;\n`
		);
		const viteBefore = read('vite.config.ts');
		const result = mergeSvelteConfig(tmp);
		expect(result).toMatchObject({
			applied: false,
			file: 'svelte.config.js',
			snippet: 'npx vela@^0.15 migrate sveltekit-3'
		});
		expect(result.reason).toMatch(/SvelteKit 3/);
		expect(fs.readFileSync(sveltePath, 'utf8')).toBe(
			`const config = {\n\tkit: {}\n};\nexport default config;\n`
		);
		expect(read('vite.config.ts')).toBe(viteBefore);
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

// vela's Kit 2 templates baked the deploy origin into prerender.origin, which
// SvelteKit 3 removed. These are their vite configs as they shipped.
const KIT2_MINIMAL_VITE = `import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-node';

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

const KIT2_STATIC_VITE = `import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-static';

const PENDING_LEGAL_ROUTES = ['/privacy', '/terms'];

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			adapter: adapter({
				fallback: '200.html'
			}),
			prerender: {
				// Every other broken link still fails the build.
				handleHttpError: ({ path, status, message }) => {
					if (status === 404 && PENDING_LEGAL_ROUTES.includes(path)) return;
					throw new Error(message);
				},
				...(process.env.VELA_ORIGIN ? { origin: process.env.VELA_ORIGIN } : {})
			}
		})
	]
});
`;

const ORIGIN_SPREAD = `...(process.env.VELA_ORIGIN ? { paths: { origin: process.env.VELA_ORIGIN } } : {})`;

/** A vite.config whose sveltekit() argument is `kit`. */
function viteWith(kit: string): string {
	return `import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit(${kit})] };\n`;
}

/** Run the merge twice: the second run must find nothing to do and leave the file byte-identical. */
function mergeOriginTwice() {
	const first = mergeOriginConfig(tmp);
	const after = read('vite.config.ts');
	const second = mergeOriginConfig(tmp);
	expect(second.applied).toBe(false);
	expect(read('vite.config.ts')).toBe(after);
	return { first, second, after };
}

describe('mergeOriginConfig', () => {
	test('swaps the minimal template spread for paths.origin in place', () => {
		write('vite.config.ts', KIT2_MINIMAL_VITE);
		const { first, second, after } = mergeOriginTwice();
		expect(first).toMatchObject({ applied: true, file: 'vite.config.ts' });
		expect(after).toBe(
			KIT2_MINIMAL_VITE.replace(
				'...(process.env.VELA_ORIGIN ? { prerender: { origin: process.env.VELA_ORIGIN } } : {})',
				ORIGIN_SPREAD
			)
		);
		expect(second.reason).toBe('paths.origin already configured');
	});

	test('takes the spread out of the static template prerender and keeps handleHttpError', () => {
		write('vite.config.ts', KIT2_STATIC_VITE);
		const { first, after } = mergeOriginTwice();
		expect(first.applied).toBe(true);
		expect(after).toBe(
			KIT2_STATIC_VITE.replace(
				`\t\t\t\t},\n\t\t\t\t...(process.env.VELA_ORIGIN ? { origin: process.env.VELA_ORIGIN } : {})\n\t\t\t}\n`,
				`\t\t\t\t}\n\t\t\t},\n\t\t\t${ORIGIN_SPREAD}\n`
			)
		);
	});

	test('drops a prerender left empty', () => {
		write(
			'vite.config.ts',
			viteWith(
				`{\n\tprerender: {\n\t\t...(process.env.VELA_ORIGIN ? { origin: process.env.VELA_ORIGIN } : {})\n\t}\n}`
			)
		);
		const { after } = mergeOriginTwice();
		expect(after).not.toContain('prerender');
		expect(after).toContain(ORIGIN_SPREAD);
	});

	test('moves a literal prerender.origin to paths.origin', () => {
		write(
			'vite.config.ts',
			viteWith(`{\n\tprerender: { origin: 'https://example.com', entries: ['*'] }\n}`)
		);
		const { first, after } = mergeOriginTwice();
		expect(first.applied).toBe(true);
		expect(after).toContain(`prerender: { entries: ['*'] }`);
		expect(after).toMatch(/paths: \{ origin: 'https:\/\/example\.com' \}/);
	});

	test('puts origin inside an existing paths object, which a top-level spread would replace', () => {
		write(
			'vite.config.ts',
			viteWith(
				`{\n\tpaths: { base: '/docs' },\n\t...(process.env.VELA_ORIGIN ? { prerender: { origin: process.env.VELA_ORIGIN } } : {})\n}`
			)
		);
		const { first, second, after } = mergeOriginTwice();
		expect(first.applied).toBe(true);
		expect(after).not.toContain('prerender');
		expect(after).toMatch(
			/paths: \{\s*base: '\/docs',\s*\.\.\.\(process\.env\.VELA_ORIGIN \? \{ origin: process\.env\.VELA_ORIGIN \} : \{\}\)\s*\}/
		);
		expect(second.reason).toBe('paths.origin already configured');
	});

	test('leaves an existing paths.origin alone and says so', () => {
		write(
			'vite.config.ts',
			viteWith(
				`{\n\tpaths: { origin: 'https://kept.example' },\n\tprerender: { origin: 'https://stale.example' }\n}`
			)
		);
		const { first, after } = mergeOriginTwice();
		expect(first.applied).toBe(true);
		expect(first.reason).toMatch(/kept the existing paths\.origin/);
		expect(after).toContain(`paths: { origin: 'https://kept.example' }`);
		expect(after).not.toContain('stale.example');
		expect(after).not.toContain('prerender');
	});

	test('a conditional paths spread without an origin does not count as one', () => {
		write(
			'vite.config.ts',
			viteWith(
				`{\n\t...(process.env.DOCS ? { paths: { base: '/docs' } } : {}),\n\tprerender: { origin: 'https://example.com' }\n}`
			)
		);
		const { first, after } = mergeOriginTwice();
		expect(first).toMatchObject({
			applied: true,
			reason: 'moved prerender.origin to paths.origin'
		});
		expect(after).toContain(`paths: { origin: 'https://example.com' }`);
		expect(after).not.toContain('prerender');
	});

	test('nothing to move is a no-op', () => {
		write('vite.config.ts', viteWith('{ adapter: adapter() }'));
		const { first } = mergeOriginTwice();
		expect(first).toMatchObject({ applied: false, reason: 'no prerender.origin to move' });
		expect(read('vite.config.ts')).toBe(viteWith('{ adapter: adapter() }'));
	});

	test('a comment written for prerender.origin is replaced with the paths.origin one', () => {
		const velabase = KIT2_MINIMAL_VITE.replace(
			'\t\t\t...(process.env.VELA_ORIGIN',
			[
				'\t\t\t// Prerendering has no request to take an origin from, so without this the',
				"\t\t\t// canonical links are built from SvelteKit's placeholder host.",
				'\t\t\t...(process.env.VELA_ORIGIN'
			].join('\n')
		);
		write('vite.config.ts', velabase);
		const { after } = mergeOriginTwice();
		expect(after).not.toContain('Prerendering has no request');
		expect(after).toContain(
			`\t\t\t${ORIGIN_COMMENT.map((l) => `// ${l}`).join('\n\t\t\t')}\n\t\t\t${ORIGIN_SPREAD}\n`
		);
	});

	test('a comment about something else stays', () => {
		const commented = KIT2_MINIMAL_VITE.replace(
			'\t\t\t...(process.env.VELA_ORIGIN',
			'\t\t\t// Set by vela build.\n\t\t\t...(process.env.VELA_ORIGIN'
		);
		write('vite.config.ts', commented);
		const { after } = mergeOriginTwice();
		expect(after).toContain(`\t\t\t// Set by vela build.\n\t\t\t${ORIGIN_SPREAD}\n`);
	});

	test('the static template: a prerender comment on the inner spread does not stay behind', () => {
		write(
			'vite.config.ts',
			KIT2_STATIC_VITE.replace(
				'\t\t\t\t...(process.env.VELA_ORIGIN',
				'\t\t\t\t// The origin prerendered pages are built for.\n\t\t\t\t...(process.env.VELA_ORIGIN'
			)
		);
		const { after } = mergeOriginTwice();
		expect(after).not.toContain('The origin prerendered pages are built for');
		expect(after).toContain(`// ${ORIGIN_COMMENT[0]}`);
		expect(after).toContain('handleHttpError');
	});

	test('restores an origin sv dropped from svelte.config', () => {
		write(
			'vite.config.ts',
			viteWith('{\n\tadapter: adapter(),\n\tcsrf: { trustedOrigins: [] }\n}')
		);
		const carry = {
			from: 'svelte.config.js',
			text: '// Prerendering has no request to take an origin from.\n...(process.env.VELA_ORIGIN ? { prerender: { origin: process.env.VELA_ORIGIN } } : {})',
			isPrerenderProperty: false
		};
		const first = mergeOriginConfig(tmp, { carry });
		expect(first).toMatchObject({ applied: true, file: 'vite.config.ts' });
		expect(first.reason).toMatch(/restored the origin sv dropped from svelte\.config\.js/);
		const after = read('vite.config.ts');
		expect(after).toContain(`\t// ${ORIGIN_COMMENT[0]}`);
		expect(after).toContain(`\t${ORIGIN_SPREAD}\n}`);
		expect(after).not.toContain('Prerendering has no request');
		expect(after).not.toContain('prerender:');
		// Once there, it is not added again.
		expect(mergeOriginConfig(tmp, { carry }).applied).toBe(false);
		expect(read('vite.config.ts')).toBe(after);
	});

	test('does not restore an origin sv already moved', () => {
		const vite = viteWith(`{\n\tpaths: { origin: 'https://example.com' }\n}`);
		write('vite.config.ts', vite);
		const carry = {
			from: 'svelte.config.js',
			text: `prerender: { origin: 'https://example.com' }`,
			isPrerenderProperty: true
		};
		expect(mergeOriginConfig(tmp, { carry }).applied).toBe(false);
		expect(read('vite.config.ts')).toBe(vite);
	});

	test('restores into a bare sveltekit() call', () => {
		write(
			'vite.config.ts',
			`import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit()] };\n`
		);
		const carry = {
			from: 'svelte.config.js',
			text: '...(process.env.VELA_ORIGIN ? { prerender: { origin: process.env.VELA_ORIGIN } } : {})',
			isPrerenderProperty: false
		};
		expect(mergeOriginConfig(tmp, { carry }).applied).toBe(true);
		expect(read('vite.config.ts')).toContain(ORIGIN_SPREAD);
	});

	test('a svelte.config gets the migrate command, not an edit', () => {
		write('vite.config.ts', KIT2_MINIMAL_VITE);
		write('svelte.config.js', `export default {};\n`);
		expect(mergeOriginConfig(tmp)).toMatchObject({
			applied: false,
			snippet: 'npx vela@^0.15 migrate sveltekit-3'
		});
		expect(read('vite.config.ts')).toBe(KIT2_MINIMAL_VITE);
	});
});

// The Kit 2 templates' tsconfig, as `vela create` wrote it.
const KIT2_TSCONFIG = `{
	"extends": "./.svelte-kit/tsconfig.json",
	"compilerOptions": {
		"rewriteRelativeImportExtensions": true,
		"allowJs": true,
		"strict": true,
		"moduleResolution": "bundler"
	}
}
`;

/** Run the merge twice: the second run must find nothing to do and leave the file byte-identical. */
function mergeTsconfigTwice(backend: boolean) {
	const first = mergeTsconfig(tmp, { backend });
	const after = read('tsconfig.json');
	const second = mergeTsconfig(tmp, { backend });
	expect(second).toMatchObject({
		applied: false,
		reason: 'tsconfig.json already set up for SvelteKit 3'
	});
	expect(read('tsconfig.json')).toBe(after);
	return { first, after };
}

describe('mergeTsconfig', () => {
	test('moves a Kit 2 vela tsconfig onto $app/tsconfig with the template include', () => {
		write('tsconfig.json', KIT2_TSCONFIG);
		write('vite.config.ts', '');
		write('vitest.config.ts', '');
		fs.mkdirSync(path.join(tmp, 'test'));
		const { first, after } = mergeTsconfigTwice(true);
		expect(first.applied).toBe(true);
		expect(JSON.parse(after)).toEqual({
			extends: '$app/tsconfig',
			compilerOptions: { allowJs: true, strict: true, moduleResolution: 'bundler' },
			include: [
				'src',
				'test',
				'vite.config.ts',
				'vitest.config.ts',
				'.svelte-kit/types/pocketbase/*.d.ts'
			]
		});
		// Too long for one line at prettier's width, so one entry per line.
		expect(after).toContain(`\t"include": [\n\t\t"src",\n`);
	});

	test('a project without a backend, tests or vitest gets src and the vite config, on one line', () => {
		write('tsconfig.json', KIT2_TSCONFIG);
		write('vite.config.js', '');
		const { after } = mergeTsconfigTwice(false);
		expect(after).toContain(`\t"include": ["src", "vite.config.js"]\n`);
		expect(after).not.toContain('pocketbase');
		expect(after).not.toContain('rewriteRelativeImportExtensions');
	});

	test('keeps what sv create wrote and adds only what is missing', () => {
		const sv = `{\n\t"extends": "$app/tsconfig",\n\t"compilerOptions": {\n\t\t"strict": true\n\t},\n\t"include": ["src", "vite.config.ts"]\n}\n`;
		write('tsconfig.json', sv);
		mergeTsconfigTwice(false);
		expect(read('tsconfig.json')).toBe(sv);

		const { first, after } = mergeTsconfigTwice(true);
		expect(first).toMatchObject({
			applied: true,
			reason: 'include .svelte-kit/types/pocketbase/*.d.ts'
		});
		expect(JSON.parse(after).include).toEqual([
			'src',
			'vite.config.ts',
			'.svelte-kit/types/pocketbase/*.d.ts'
		]);
	});

	test('replaces the generated config inside an extends array', () => {
		write(
			'tsconfig.json',
			JSON.stringify(
				{ extends: ['./.svelte-kit/tsconfig.json', './base.json'], include: ['./src/'] },
				null,
				2
			)
		);
		const { after } = mergeTsconfigTwice(false);
		const parsed = JSON.parse(after);
		expect(parsed.extends).toEqual(['$app/tsconfig', './base.json']);
		expect(parsed.include).toEqual(['./src/', 'vite.config.ts']);
		// The file's own two-space indent.
		expect(after).toContain('\n  "extends": [');
	});

	test('a file with comments is left alone, with the file vela would write as the snippet', () => {
		const commented = KIT2_TSCONFIG.replace(
			'"allowJs": true,',
			'// keep JS checked\n\t\t"allowJs": true,'
		);
		write('tsconfig.json', commented);
		const result = mergeTsconfig(tmp, { backend: false });
		expect(result.applied).toBe(false);
		expect(result.reason).toMatch(/comments/);
		expect(JSON.parse(result.snippet!)).toMatchObject({
			extends: '$app/tsconfig',
			include: ['src', 'vite.config.ts']
		});
		expect(read('tsconfig.json')).toBe(commented);
	});

	test('a commented file with nothing to change is just unchanged', () => {
		write(
			'tsconfig.json',
			`{\n\t// sv\n\t"extends": "$app/tsconfig",\n\t"include": ["src", "vite.config.ts"]\n}\n`
		);
		expect(mergeTsconfig(tmp, { backend: false })).toEqual({
			applied: false,
			reason: 'tsconfig.json already set up for SvelteKit 3',
			file: 'tsconfig.json'
		});
	});

	test('an unrelated extends is not guessed at', () => {
		write('tsconfig.json', JSON.stringify({ extends: '@tsconfig/strictest' }));
		const result = mergeTsconfig(tmp, { backend: false });
		expect(result.applied).toBe(false);
		expect(result.snippet).toBe(`"extends": ["$app/tsconfig","@tsconfig/strictest"]`);
	});

	test('a missing tsconfig is reported', () => {
		expect(mergeTsconfig(tmp, { backend: false })).toMatchObject({
			applied: false,
			reason: 'tsconfig.json not found'
		});
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

/** velastack.dev's svelte.config before its SvelteKit 3 migration, trimmed of mdsvex. */
const VELASTACK_SVELTE_CONFIG = `import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	extensions: ['.svelte', '.svx'],
	preprocess: [vitePreprocess()],

	kit: {
		alias: {
			$locales: 'src/locales'
		},
		adapter: adapter(),
		csrf: { trustedOrigins: ['*'] },
		// Prerendering has no request to take an origin from, so without this the
		// canonical, og:url and hreflang links on every prerendered page are built
		// from SvelteKit's placeholder host.
		...(process.env.VELA_ORIGIN ? { prerender: { origin: process.env.VELA_ORIGIN } } : {})
	}
};

export default config;
`;

describe('captureSvelteConfig', () => {
	test("velastack.dev's config: the origin spread and its comment", () => {
		write('svelte.config.js', VELASTACK_SVELTE_CONFIG);
		const capture = captureSvelteConfig(tmp)!;
		expect(capture.file).toBe('svelte.config.js');
		expect(capture.spreads).toEqual([
			'...(process.env.VELA_ORIGIN ? { prerender: { origin: process.env.VELA_ORIGIN } } : {})'
		]);
		expect(capture.origin).toEqual({
			from: 'svelte.config.js',
			isPrerenderProperty: false,
			text: [
				'// Prerendering has no request to take an origin from, so without this the',
				'// canonical, og:url and hreflang links on every prerendered page are built',
				"// from SvelteKit's placeholder host.",
				'...(process.env.VELA_ORIGIN ? { prerender: { origin: process.env.VELA_ORIGIN } } : {})'
			].join('\n')
		});
	});

	test('then restored after sv into the inline config sv wrote', () => {
		write('svelte.config.js', VELASTACK_SVELTE_CONFIG);
		const capture = captureSvelteConfig(tmp)!;
		fs.rmSync(path.join(tmp, 'svelte.config.js'));
		// What sv 1.0.1 writes for it: everything but the spread.
		write(
			'vite.config.ts',
			viteWith(
				`{\n\textensions: ['.svelte', '.svx'],\n\tpreprocess: [vitePreprocess()],\n\talias: { $locales: 'src/locales' },\n\tadapter: adapter(),\n\tcsrf: { trustedOrigins: ['*'] }\n}`
			)
		);
		expect(mergeOriginConfig(tmp, { carry: capture.origin }).applied).toBe(true);
		const after = read('vite.config.ts');
		expect(after).toContain(`\tcsrf: { trustedOrigins: ['*'] },\n\t// ${ORIGIN_COMMENT[0]}`);
		expect(after).toContain(ORIGIN_SPREAD);
	});

	test('top-level and kit spreads, a literal origin, defineConfig and satisfies', () => {
		write(
			'svelte.config.ts',
			`import type { Config } from '@sveltejs/kit';
const extra = {};
export default {
	...extra,
	kit: {
		paths: { ...(process.env.X ? { relative: false } : {}) },
		prerender: { origin: 'https://example.com', entries: ['*'] },
		...(process.env.CSP ? { csp: {} } : {})
	}
} satisfies Config;
`
		);
		const capture = captureSvelteConfig(tmp)!;
		// Nested spreads survive sv, so only these two are lost.
		expect(capture.spreads).toEqual(['...extra', '...(process.env.CSP ? { csp: {} } : {})']);
		expect(capture.origin).toEqual({
			from: 'svelte.config.ts',
			isPrerenderProperty: true,
			text: `prerender: { origin: 'https://example.com', entries: ['*'] }`
		});
	});

	test('no svelte.config is null; one that is not an object literal captures nothing', () => {
		expect(captureSvelteConfig(tmp)).toBeNull();
		write('svelte.config.js', `import config from './shared.js';\nexport default make(config);\n`);
		expect(captureSvelteConfig(tmp)).toEqual({ file: 'svelte.config.js', spreads: [] });
	});
});
