import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	excludeGlob,
	Kit3MigrationError,
	MIGRATION_TASKS_FILE,
	parseSvFailure,
	runKit3Migration,
	svArgs,
	svBin,
	SV_TASKS,
	type Kit3MigrationOptions,
	type MigrationLog,
	type SvRunner
} from './kit3-migrate.ts';
import { commitAll, copyKit2Fixture, snapshot } from './kit2-fixture.ts';
import type { PeerLookup, PeerManifest } from './kit-peers.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(name: 'minimal' | 'static', options?: { git?: boolean }): string {
	const dir = copyKit2Fixture(name, options);
	dirs.push(dir);
	return dir;
}

const silent: MigrationLog = { step: () => {}, info: () => {}, warn: () => {}, success: () => {} };

/** An sv that succeeds without touching anything, recording what it was asked. */
function fakeSv(results: Array<{ code: number; output: string }> = []) {
	const calls: string[][] = [];
	const runner: SvRunner = async (args) => {
		calls.push(args);
		return results.shift() ?? { code: 0, output: '' };
	};
	return { calls, runner };
}

/**
 * An sv that does to the project what sv 1.0.1 did to velastack.dev: writes
 * these files (null deletes one), then succeeds.
 */
function svThatWrites(dir: string, files: Record<string, string | null>): SvRunner {
	return async () => {
		for (const [rel, content] of Object.entries(files)) {
			const file = path.join(dir, rel);
			if (content === null) fs.rmSync(file, { force: true });
			else {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, content);
			}
		}
		return { code: 0, output: '' };
	};
}

/** velastack.dev's svelte.config at 24c9a86 (its last SvelteKit 2 commit), trimmed. */
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
		// from SvelteKit's placeholder host. \`vela build\` sets it from the domain
		// this target is deployed on; unset, SvelteKit's default stands.
		...(process.env.VELA_ORIGIN ? { prerender: { origin: process.env.VELA_ORIGIN } } : {})
	}
};

export default config;
`;

/** What sv 1.0.1 made of it: the config inline, the spread gone. */
const VELASTACK_VITE_AFTER_SV = `import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			extensions: ['.svelte', '.svx'],
			preprocess: [vitePreprocess()],
			alias: { $locales: 'src/locales' },
			adapter: adapter(),
			csrf: { trustedOrigins: ['*'] }
		})
	]
});
`;

const base: Kit3MigrationOptions = {
	install: false,
	log: silent,
	cliVersion: '0.15.0',
	// No registry in tests: every third-party package peers nothing.
	peerLookup: async () => ({ version: '1.0.0' })
};

function readJson(dir: string, file: string) {
	return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
}

function setPkg(dir: string, edit: (pkg: Record<string, any>) => void) {
	const pkg = readJson(dir, 'package.json');
	edit(pkg);
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, '\t') + '\n');
}

describe('excludeGlob', () => {
	const files = [
		'src/routes/[slug]/+page.server.ts',
		'src/routes/(app)/a(1).spec.ts',
		'src/lib/x.spec.ts'
	];
	const glob = excludeGlob(files);

	test.each(files)('rejects %s', (file) => {
		expect(path.matchesGlob(file, glob)).toBe(false);
	});

	test.each([
		'src/routes/[slug]/+page.svelte',
		'src/routes/[slug]/+page.server.js',
		'src/routes/(app)/b.spec.ts',
		'src/routes/blog/+page.server.ts',
		'src/lib/y.spec.ts',
		'src/lib/sub/x.spec.ts',
		'src/hooks.server.ts',
		'vite.config.ts',
		'package.json',
		'test/setup.ts'
	])('accepts %s', (file) => {
		expect(path.matchesGlob(file, glob)).toBe(true);
	});
});

describe('sv invocation', () => {
	test('the flags sv 1.0 takes, through the bin vela depends on', () => {
		expect(svArgs('/p', 'all', [])).toEqual([
			'migrate',
			'sveltekit-3',
			'--cwd',
			'/p',
			'--tasks',
			'all',
			'--confirm',
			'--no-install',
			'--no-git-check'
		]);
		const bin = svBin();
		expect(fs.existsSync(bin)).toBe(true);
		expect(path.basename(bin)).toBe('bin.mjs');
	});

	test('parseSvFailure reads the task and file out of colored output', () => {
		const output =
			"\u001b[33m▲  Task 'imports' failed: Unable to process 'src/lib/a.spec.ts'. Reason: Unterminated template literal\u001b[39m\n└  Migration failed.";
		expect(parseSvFailure(output)).toEqual({
			task: 'imports',
			file: 'src/lib/a.spec.ts',
			message: "Unable to process 'src/lib/a.spec.ts'. Reason: Unterminated template literal"
		});
		expect(parseSvFailure("Task 'paths' failed: boom")).toEqual({ task: 'paths', message: 'boom' });
		expect(parseSvFailure('all good')).toBeNull();
	});
});

describe('preflight', () => {
	test('refuses a dirty tree, and --force runs anyway', async () => {
		const dir = fixture('minimal', { git: true });
		fs.writeFileSync(path.join(dir, 'src', 'scratch.ts'), 'export {};\n');
		const sv = fakeSv();
		await expect(runKit3Migration(dir, { ...base, runSv: sv.runner })).rejects.toThrow(
			/uncommitted changes[\s\S]*src\/scratch\.ts/
		);
		expect(sv.calls).toEqual([]);
		await runKit3Migration(dir, { ...base, runSv: sv.runner, force: true });
		expect(sv.calls).toHaveLength(1);
	});

	test('refuses a project outside git unless the caller says not to check', async () => {
		const dir = fixture('static');
		const sv = fakeSv();
		await expect(runKit3Migration(dir, { ...base, runSv: sv.runner })).rejects.toThrow(
			/not in a git repository/
		);
		await runKit3Migration(dir, { ...base, runSv: sv.runner, gitCheck: false });
		expect(sv.calls).toHaveLength(1);
	});

	test('runs sv on Kit 2 with the documented flags', async () => {
		const dir = fixture('minimal', { git: true });
		const sv = fakeSv();
		const result = await runKit3Migration(dir, { ...base, runSv: sv.runner });
		expect(result.mode).toBe('migrate');
		expect(sv.calls).toEqual([svArgs(dir, 'all', [])]);
	});

	test('Kit 3 without a svelte.config is repair mode: no sv, only the vela steps', async () => {
		const dir = fixture('minimal');
		setPkg(dir, (pkg) => (pkg.devDependencies['@sveltejs/kit'] = '^3.0.0'));
		const sv = fakeSv();
		const result = await runKit3Migration(dir, { ...base, runSv: sv.runner, gitCheck: false });
		expect(result.mode).toBe('repair');
		expect(result.sv.ran).toBe(false);
		expect(sv.calls).toEqual([]);
		// The vela steps still ran: the origin moved.
		expect(fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8')).toContain('paths: { origin');
	});

	test('Kit 3 with a leftover svelte.config still runs sv', async () => {
		const dir = fixture('static');
		setPkg(dir, (pkg) => (pkg.devDependencies['@sveltejs/kit'] = '^3.0.0'));
		fs.writeFileSync(path.join(dir, 'svelte.config.js'), 'export default {};\n');
		const sv = fakeSv();
		const result = await runKit3Migration(dir, { ...base, runSv: sv.runner, gitCheck: false });
		expect(result.mode).toBe('migrate');
		expect(sv.calls).toHaveLength(1);
	});

	test('refuses Kit 1', async () => {
		const dir = fixture('static');
		setPkg(dir, (pkg) => (pkg.devDependencies['@sveltejs/kit'] = '^1.30.0'));
		await expect(runKit3Migration(dir, { ...base, gitCheck: false })).rejects.toThrow(
			/SvelteKit 1[\s\S]*sveltekit-2/
		);
	});

	test('refuses kit outside devDependencies, and no kit at all', async () => {
		const dir = fixture('static');
		setPkg(dir, (pkg) => {
			pkg.dependencies = { '@sveltejs/kit': pkg.devDependencies['@sveltejs/kit'] };
			delete pkg.devDependencies['@sveltejs/kit'];
		});
		await expect(runKit3Migration(dir, { ...base, gitCheck: false })).rejects.toThrow(
			/in dependencies; sv migrates it only from devDependencies/
		);
		setPkg(dir, (pkg) => delete pkg.dependencies['@sveltejs/kit']);
		await expect(runKit3Migration(dir, { ...base, gitCheck: false })).rejects.toThrow(
			/not a devDependency/
		);
	});

	test('refuses Node below 22.17', async () => {
		const dir = fixture('static');
		await expect(
			runKit3Migration(dir, { ...base, gitCheck: false, nodeVersion: '22.16.0' })
		).rejects.toBeInstanceOf(Kit3MigrationError);
	});
});

describe('sv parser failure', () => {
	test('reports the task and file, then re-runs the rest one by one without it', async () => {
		const dir = fixture('minimal', { git: true });
		fs.writeFileSync(
			path.join(dir, 'src', 'lib', 'embed.ts'),
			"import { site } from '$lib/site';\nexport const s = `<script>${site.name}</script>`;\n"
		);
		commitAll(dir, 'embed');
		const failure =
			"Task 'imports' failed: Unable to process 'src/lib/embed.ts'. Reason: Unterminated template literal";
		const sv = fakeSv([{ code: 1, output: failure }]);
		const warnings: string[] = [];
		const result = await runKit3Migration(dir, {
			...base,
			runSv: sv.runner,
			log: { ...silent, warn: (m) => warnings.push(m) }
		});

		const rest = SV_TASKS.slice(SV_TASKS.indexOf('imports'));
		expect(sv.calls).toEqual([
			svArgs(dir, 'all', []),
			...rest.map((task) => svArgs(dir, task, ['src/lib/embed.ts']))
		]);
		const glob = sv.calls[1]!.at(-1)!;
		expect(path.matchesGlob('src/lib/embed.ts', glob)).toBe(false);
		expect(path.matchesGlob('src/lib/site.ts', glob)).toBe(true);

		expect(result.sv.failures).toEqual([
			{ task: 'imports', file: 'src/lib/embed.ts', message: expect.any(String) }
		]);
		expect(warnings.join('\n')).toContain('imports task could not process src/lib/embed.ts');
		// sv's lib-alias never saw the file, so vela rewrote its $lib import.
		expect(fs.readFileSync(path.join(dir, 'src/lib/embed.ts'), 'utf8')).toContain(
			"from '#lib/site.js'"
		);
		expect(result.followUps[0]).toMatch(
			/^`src\/lib\/embed\.ts`: sv's `imports` task could not parse it/
		);
		// A later run (sv skipped) keeps the item instead of dropping it unresolved.
		commitAll(dir, 'migrated');
		setPkg(dir, () => {});
		const again = await runKit3Migration(dir, { ...base, force: true, runSv: sv.runner });
		expect(again.mode).toBe('repair');
		expect(again.followUps[0]).toBe(result.followUps[0]);
	});

	test('a failure in another task during recovery is excluded too', async () => {
		const dir = fixture('static');
		const sv = fakeSv([
			{ code: 1, output: "Task 'params' failed: Unable to process 'src/a.ts'. Reason: x" },
			{ code: 1, output: "Task 'params' failed: Unable to process 'src/b.ts'. Reason: y" }
		]);
		const result = await runKit3Migration(dir, { ...base, gitCheck: false, runSv: sv.runner });
		expect(result.sv.excluded).toEqual(['src/a.ts', 'src/b.ts']);
		expect(sv.calls[2]).toEqual(svArgs(dir, 'params', ['src/a.ts', 'src/b.ts']));
		expect(sv.calls.at(-1)).toEqual(
			svArgs(dir, 'collect-migration-instructions', ['src/a.ts', 'src/b.ts'])
		);
	});

	test('a failure sv does not attribute to a task stops the migration', async () => {
		const dir = fixture('static');
		const sv = fakeSv([{ code: 1, output: 'Error: something else' }]);
		await expect(
			runKit3Migration(dir, { ...base, gitCheck: false, runSv: sv.runner })
		).rejects.toThrow(/sv migrate sveltekit-3 failed/);
	});
});

describe('svelte.config spreads', () => {
	test('velastack.dev: the origin sv dropped is restored as paths.origin, other spreads are follow-ups', async () => {
		const dir = fixture('minimal', { git: true });
		fs.writeFileSync(
			path.join(dir, 'svelte.config.js'),
			VELASTACK_SVELTE_CONFIG.replace(
				'\t\tcsrf:',
				'\t\t...(process.env.CSP ? { csp: { mode: "auto" } } : {}),\n\t\tcsrf:'
			)
		);
		commitAll(dir, 'svelte.config');
		const runSv = svThatWrites(dir, {
			'svelte.config.js': null,
			'vite.config.ts': VELASTACK_VITE_AFTER_SV
		});
		const first = await runKit3Migration(dir, { ...base, runSv });

		const vite = fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8');
		expect(vite).toContain(
			[
				"\t\t\tcsrf: { trustedOrigins: ['*'] },",
				'\t\t\t// The public origin, which SvelteKit checks form posts against and uses',
				'\t\t\t// for prerendered pages. `vela deploy` sets VELA_ORIGIN, and the value is',
				'\t\t\t// baked in at build time. It is left unset for a deploy that serves more',
				"\t\t\t// than one host, where each request's own origin is used instead.",
				'\t\t\t...(process.env.VELA_ORIGIN ? { paths: { origin: process.env.VELA_ORIGIN } } : {})'
			].join('\n')
		);
		expect(vite).not.toContain('prerender:');
		expect(first.fixups.find((f) => f.name === 'origin')!.details[0]).toMatch(
			/restored the origin sv dropped from svelte\.config\.js/
		);
		expect(first.sv.dropped).toEqual([
			{ file: 'svelte.config.js', text: '...(process.env.CSP ? { csp: { mode: "auto" } } : {})' }
		]);
		const dropped = first.followUps.filter((item) => item.includes('sv dropped'));
		expect(dropped).toEqual([
			'`svelte.config.js`: sv dropped `...(process.env.CSP ? { csp: { mode: "auto" } } : {})` when it moved the config into `sveltekit({...})` (it skips spread properties). Add it back there if it is still needed.'
		]);

		// The second run cannot see svelte.config any more, and keeps the item.
		commitAll(dir, 'migrated');
		const before = snapshot(dir);
		const again = await runKit3Migration(dir, { ...base, runSv });
		expect(again.mode).toBe('repair');
		expect(again.followUps).toEqual(expect.arrayContaining(dropped));
		expect(snapshot(dir)).toEqual(before);
	});
});

describe('third-party SvelteKit 2 peers', () => {
	const registry: Record<string, PeerManifest> = {
		'@icons-pack/svelte-simple-icons': {
			version: '7.2.0',
			peerDependencies: { '@sveltejs/kit': '^2.5.0', svelte: '^5.0.0' }
		},
		'pocketbase-sveltekit': {
			version: '0.28.2',
			peerDependencies: { '@sveltejs/kit': '^2.0.0 || ^3.0.0' }
		},
		'svelte-meta-tags': { version: '5.0.2', peerDependencies: { svelte: '^5.0.0' } }
	};

	test('overrides the kit peer of each one that stops at Kit 2, once, from node_modules or the registry', async () => {
		const dir = fixture('minimal');
		setPkg(dir, (pkg) => {
			Object.assign(pkg.devDependencies, {
				'@icons-pack/svelte-simple-icons': '^7.2.0',
				'pocketbase-sveltekit': '^0.28.1',
				'svelte-meta-tags': '^5.0.2',
				'local-kit2': '^1.0.0'
			});
		});
		const local = path.join(dir, 'node_modules', 'local-kit2');
		fs.mkdirSync(local, { recursive: true });
		fs.writeFileSync(
			path.join(local, 'package.json'),
			JSON.stringify({ version: '1.0.4', peerDependencies: { '@sveltejs/kit': '^2.0.0' } })
		);
		const asked: string[] = [];
		const peerLookup: PeerLookup = async (name, range) => {
			asked.push(`${name}@${range}`);
			return registry[name] ?? { version: '1.0.0' };
		};

		const first = await runKit3Migration(dir, {
			...base,
			gitCheck: false,
			skipSv: true,
			peerLookup
		});
		expect(asked).toEqual(
			expect.arrayContaining([
				'@icons-pack/svelte-simple-icons@^7.2.0',
				'pocketbase-sveltekit@^0.28.1',
				'svelte-meta-tags@^5.0.2'
			])
		);
		// Installed, vela's own, or bumped by the migration: not asked about.
		for (const name of [
			'local-kit2',
			'vela',
			'@sveltejs/kit',
			'@velastack/kit',
			'svelte',
			'sveltekit-superforms'
		]) {
			expect(asked.some((a) => a.startsWith(`${name}@`))).toBe(false);
		}
		expect(readJson(dir, 'package.json').overrides).toEqual({
			formsnap: { 'sveltekit-superforms': '3.0.0-next.1' },
			'@icons-pack/svelte-simple-icons': { '@sveltejs/kit': '^3.0.0' },
			'local-kit2': { '@sveltejs/kit': '^3.0.0' }
		});
		const peers = first.fixups.find((f) => f.name === 'SvelteKit 2 peers')!;
		expect(peers.details).toContain(
			'overrides @icons-pack/svelte-simple-icons → @sveltejs/kit ^3.0.0 (@icons-pack/svelte-simple-icons@7.2.0 peers @sveltejs/kit ^2.5.0)'
		);
		expect(first.followUps).toEqual(
			expect.arrayContaining([
				'`@icons-pack/svelte-simple-icons` declares a SvelteKit 2 peer; overridden (`overrides` in package.json). Check it works and watch for an update that supports SvelteKit 3.',
				'`local-kit2` declares a SvelteKit 2 peer; overridden (`overrides` in package.json). Check it works and watch for an update that supports SvelteKit 3.'
			])
		);

		// The second run asks nothing about the overridden ones and writes the same.
		asked.length = 0;
		const before = snapshot(dir);
		const second = await runKit3Migration(dir, {
			...base,
			gitCheck: false,
			skipSv: true,
			peerLookup
		});
		expect(asked.some((a) => a.startsWith('@icons-pack/'))).toBe(false);
		expect(second.fixups.filter((f) => f.changed)).toEqual([]);
		expect(second.followUps).toEqual(first.followUps);
		expect(snapshot(dir)).toEqual(before);
	});

	test('offline: the packages are listed as unchecked, and the registry is not asked about every one', async () => {
		const dir = fixture('static');
		setPkg(dir, (pkg) => {
			Object.assign(pkg.devDependencies, {
				'@icons-pack/svelte-simple-icons': '^7.2.0',
				'svelte-meta-tags': '^5.0.2'
			});
		});
		const peerLookup = vi.fn<PeerLookup>(async () => {
			throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
		});
		const result = await runKit3Migration(dir, {
			...base,
			gitCheck: false,
			skipSv: true,
			peerLookup
		});
		const third = Object.keys(readJson(dir, 'package.json').devDependencies).filter(
			(name) =>
				!/^(@sveltejs|@velastack|@types)\/|^(vela|svelte|vite|svelte-check|typescript|shadcn-svelte)$/.test(
					name
				)
		);
		expect(third.length).toBeGreaterThan(8);
		expect(peerLookup.mock.calls.length).toBeLessThan(third.length);
		const unchecked = result.followUps.find((item) =>
			item.startsWith('Could not ask the npm registry')
		);
		expect(unchecked).toContain('`@icons-pack/svelte-simple-icons`');
		expect(unchecked).toContain('`svelte-meta-tags`');
		expect(readJson(dir, 'package.json').overrides).toBeUndefined();
	});
});

describe('vela steps', () => {
	for (const name of ['minimal', 'static'] as const) {
		test(`${name}: every step reports a change once, and a second run changes nothing`, async () => {
			const dir = fixture(name);
			const first = await runKit3Migration(dir, { ...base, gitCheck: false, skipSv: true });
			expect(first.fixups.filter((f) => f.changed).map((f) => f.name)).toEqual(
				expect.arrayContaining(['origin', '#lib', 'tsconfig.json', 'package.json'])
			);
			const before = snapshot(dir);
			const second = await runKit3Migration(dir, { ...base, gitCheck: false, skipSv: true });
			expect(second.fixups.filter((f) => f.changed)).toEqual([]);
			expect(snapshot(dir)).toEqual(before);
		});
	}

	test('minimal: origin, env, #lib, tsconfig and packages land as the templates have them', async () => {
		const dir = fixture('minimal');
		await runKit3Migration(dir, { ...base, gitCheck: false, skipSv: true });

		const vite = fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8');
		expect(vite).toContain(
			'...(process.env.VELA_ORIGIN ? { paths: { origin: process.env.VELA_ORIGIN } } : {})'
		);
		expect(vite).not.toContain('prerender');

		// sv did not run, so the code still reads env.X through $env/dynamic:
		// every vela variable it reads is declared.
		const env = fs.readFileSync(path.join(dir, 'src', 'env.ts'), 'utf8');
		for (const name of ['POCKETBASE_URL', 'WORKFLOWS_CONCURRENCY', 'TEST']) {
			expect(env).toContain(`${name}: {`);
		}

		const pkg = readJson(dir, 'package.json');
		expect(pkg.imports).toEqual({ '#lib': './src/lib/index.js', '#lib/*': './src/lib/*' });
		expect(pkg.engines).toEqual({ node: '>=22.17' });
		expect(pkg.devDependencies).toMatchObject({
			'@sveltejs/kit': '^3.0.0',
			'@sveltejs/adapter-node': '^6.0.0',
			'@velastack/kit': '^0.4.0',
			'@velastack/pocketbase': '^0.4.0',
			'sveltekit-superforms': '3.0.0-next.1',
			'sveltekit-flash-message': '3.0.0-next.0',
			svelte: '^5.57.1',
			'svelte-check': '^4.7.6',
			'shadcn-svelte': '^1.7.0',
			vela: '^0.15.0'
		});
		expect(pkg.overrides).toEqual({ formsnap: { 'sveltekit-superforms': '3.0.0-next.1' } });

		expect(readJson(dir, 'components.json').aliases.ui).toBe('#lib/components/ui');
		expect(readJson(dir, 'tsconfig.json')).toMatchObject({
			extends: '$app/tsconfig',
			include: [
				'src',
				'test',
				'vite.config.ts',
				'vitest.config.ts',
				'.svelte-kit/types/pocketbase/*.d.ts'
			]
		});
	});

	test('static: no backend types in tsconfig, no form pins, no server follow-up', async () => {
		const dir = fixture('static');
		const result = await runKit3Migration(dir, { ...base, gitCheck: false, skipSv: true });
		expect(readJson(dir, 'tsconfig.json').include).toEqual(['src', 'vite.config.ts']);
		const pkg = readJson(dir, 'package.json');
		expect(pkg.devDependencies['@sveltejs/adapter-static']).toBe('^4.0.0');
		expect(pkg.overrides).toBeUndefined();
		expect(result.genericFollowUps).toEqual([]);
		expect(fs.existsSync(path.join(dir, 'src', 'env.ts'))).toBe(false);
	});

	test('@velastack/patterns and sveltekit-negotiate are raised, and their stale lock entries dropped', async () => {
		const dir = fixture('static');
		setPkg(dir, (pkg) => {
			pkg.devDependencies['@velastack/patterns'] = '^0.3.4';
			pkg.dependencies = { ...pkg.dependencies, 'sveltekit-negotiate': '^0.3.0' };
		});
		const lock = {
			name: 'static-fixture',
			lockfileVersion: 3,
			packages: {
				'': {},
				'node_modules/@velastack/patterns': { version: '0.3.4' },
				'node_modules/sveltekit-negotiate': { version: '0.3.0' },
				'node_modules/clsx': { version: '2.1.1' }
			}
		};
		fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock, null, '\t'));
		const result = await runKit3Migration(dir, { ...base, gitCheck: false, skipSv: true });
		const pkg = readJson(dir, 'package.json');
		expect(pkg.devDependencies['@velastack/patterns']).toBe('^0.4.0');
		expect(pkg.dependencies['sveltekit-negotiate']).toBe('^0.3.1');
		expect(result.fixups.find((f) => f.name === 'package.json')!.details).toEqual(
			expect.arrayContaining([
				'@velastack/patterns ^0.3.4 → ^0.4.0',
				'sveltekit-negotiate ^0.3.0 → ^0.3.1'
			])
		);
		expect(Object.keys(readJson(dir, 'package-lock.json').packages)).toEqual([
			'',
			'node_modules/clsx'
		]);

		// A Kit 3 project already on negotiate 0.3.0 is raised too.
		setPkg(dir, (p) => (p.dependencies['sveltekit-negotiate'] = '^0.3.0'));
		lock.packages = { '': {}, 'node_modules/sveltekit-negotiate': { version: '0.3.0' } } as never;
		fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock, null, '\t'));
		await runKit3Migration(dir, { ...base, gitCheck: false });
		expect(readJson(dir, 'package.json').dependencies['sveltekit-negotiate']).toBe('^0.3.1');
		expect(Object.keys(readJson(dir, 'package-lock.json').packages)).toEqual(['']);
	});

	test('a Kit 2 package-lock loses its stale entries, a Kit 3 one keeps them', async () => {
		const dir = fixture('static');
		const lock = {
			name: 'static-fixture',
			lockfileVersion: 3,
			packages: {
				'': {},
				'node_modules/@sveltejs/kit': { version: '2.70.3' },
				'node_modules/@sveltejs/acorn-typescript': { version: '1.0.5' },
				'node_modules/@sveltejs/adapter-static': { version: '3.0.10' },
				'node_modules/@velastack/kit': { version: '0.3.0' },
				'node_modules/clsx': { version: '2.1.1' }
			}
		};
		fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock, null, '\t'));
		await runKit3Migration(dir, { ...base, gitCheck: false, skipSv: true });
		expect(Object.keys(readJson(dir, 'package-lock.json').packages)).toEqual([
			'',
			'node_modules/clsx'
		]);

		const kit3 = {
			...lock,
			packages: {
				'': {},
				'node_modules/@sveltejs/kit': { version: '3.0.0' },
				'node_modules/@sveltejs/acorn-typescript': { version: '1.0.5' }
			}
		};
		fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(kit3, null, '\t'));
		const result = await runKit3Migration(dir, { ...base, gitCheck: false });
		expect(result.fixups.find((f) => f.name === 'package-lock.json')?.changed).toBe(false);
	});

	test('vela variables: ?? → || in src, reported once; a second run changes nothing', async () => {
		const dir = fixture('minimal');
		setPkg(dir, (pkg) => (pkg.devDependencies['@sveltejs/kit'] = '^3.0.0'));
		// What sv's environment task leaves: named imports from $app/env/private.
		const workflows = path.join(dir, 'src', 'lib', 'server', 'workflows.ts');
		fs.writeFileSync(
			workflows,
			fs
				.readFileSync(workflows, 'utf8')
				.replace(
					/import \{ env \} from '\$env\/dynamic\/private';/,
					"import { POCKETBASE_URL, POCKETBASE_SUPERUSER_EMAIL, POCKETBASE_SUPERUSER_PASSWORD, WORKFLOWS_ENABLED, WORKFLOWS_CONCURRENCY, TEST } from '$app/env/private';"
				)
				.replace(/\benv\.([A-Z_]+)/g, '$1')
		);
		const first = await runKit3Migration(dir, { ...base, gitCheck: false });
		const source = fs.readFileSync(workflows, 'utf8');
		expect(source).toContain('Number(WORKFLOWS_CONCURRENCY || 5)');
		expect(source).toContain("const url = POCKETBASE_URL ?? '';");
		const code = first.fixups.find((f) => f.name === 'code')!;
		expect(code.details).toContainEqual(
			expect.stringMatching(
				/^src\/lib\/server\/workflows\.ts line \d+: WORKFLOWS_CONCURRENCY \?\? 5 → WORKFLOWS_CONCURRENCY \|\| 5$/
			)
		);
		expect(first.followUps.join('\n')).not.toContain('WORKFLOWS_CONCURRENCY');

		const before = snapshot(dir);
		const second = await runKit3Migration(dir, { ...base, gitCheck: false });
		expect(second.fixups.filter((f) => f.changed)).toEqual([]);
		expect(snapshot(dir)).toEqual(before);
	});

	test('follow-ups: ?? on env imports, ORIGIN, literal paths.origin; replaced, not appended', async () => {
		const dir = fixture('minimal');
		setPkg(dir, (pkg) => (pkg.devDependencies['@sveltejs/kit'] = '^3.0.0'));
		fs.writeFileSync(
			path.join(dir, 'src', 'lib', 'server', 'config.ts'),
			[
				"import { WORKFLOWS_CONCURRENCY, POCKETBASE_URL, ORIGIN, STRIPE_SECRET_KEY } from '$app/env/private';",
				'export const concurrency = Number(WORKFLOWS_CONCURRENCY ?? 5);',
				"export const stripe = STRIPE_SECRET_KEY ?? 'sk_test';",
				"export const url = POCKETBASE_URL ?? '';",
				'export const origin = ORIGIN;',
				''
			].join('\n')
		);
		fs.writeFileSync(
			path.join(dir, 'src', 'routes', 'links.svelte'),
			'<a href="/a" data-sveltekit-noscroll>a</a>\n<a href="/b" data-sveltekit-reset="false">b</a>\n'
		);
		fs.writeFileSync(
			path.join(dir, MIGRATION_TASKS_FILE),
			'<!-- Generated by sv migrate sveltekit-3:collect-migration-instructions -->\n\n# SvelteKit 3 migration tasks\n\n## Migration tasks\n\n### X\n\nY\n\n#### Files to review\n\n- [ ] `src/a.ts`\n\n## Final verification\n\n- [ ] Done.\n'
		);
		const vite = path.join(dir, 'vite.config.ts');
		fs.writeFileSync(
			vite,
			fs
				.readFileSync(vite, 'utf8')
				.replace(/\.\.\.\(process\.env\.VELA_ORIGIN[^\n]*/, "paths: { origin: 'https://a.test' }")
		);

		const first = await runKit3Migration(dir, { ...base, gitCheck: false });
		const joined = first.followUps.join('\n');
		// vela's own variable is rewritten; any other is only reported.
		expect(joined).not.toContain('WORKFLOWS_CONCURRENCY ??');
		expect(joined).toContain("`STRIPE_SECRET_KEY ?? 'sk_test'`");
		expect(joined).not.toContain("POCKETBASE_URL ?? ''");
		expect(joined).toContain('`export const origin = ORIGIN;`');
		expect(joined).toContain('`paths.origin` is a literal');
		expect(joined).toContain(
			'`src/routes/links.svelte`: `<a href="/a" data-sveltekit-noscroll>a</a>`'
		);
		expect(joined).toContain('`<a href="/b" data-sveltekit-reset="false">b</a>`');
		expect(joined).toContain('write `data-sveltekit-reset={false}`');
		expect(first.tasks).toMatchObject({
			sections: [{ title: 'X', files: ['src/a.ts'] }],
			filesToReview: 1
		});

		const tasks = fs.readFileSync(path.join(dir, MIGRATION_TASKS_FILE), 'utf8');
		expect(tasks.indexOf('## VelaStack follow-ups')).toBeLessThan(
			tasks.indexOf('## Final verification')
		);
		await runKit3Migration(dir, { ...base, gitCheck: false });
		expect(fs.readFileSync(path.join(dir, MIGRATION_TASKS_FILE), 'utf8')).toBe(tasks);
	});

	test('installs through the injected installer, and formats nothing outside git', async () => {
		const dir = fixture('static');
		const installer = vi.fn(async () => true);
		const result = await runKit3Migration(dir, {
			...base,
			install: true,
			installer,
			gitCheck: false,
			skipSv: true
		});
		expect(installer).toHaveBeenCalledWith(dir);
		expect(result.installed).toBe(true);
		expect(result.formatted).toEqual([]);
	});
});

/**
 * Real sv on the Kit 2 fixture. Opt-in: it spawns sv and takes a few seconds.
 * `VELA_E2E=1 npx vitest run src/lib/kit3-migrate.test.ts`
 */
describe.skipIf(!process.env.VELA_E2E)('e2e: real sv on the Kit 2 fixture', () => {
	test('minimal migrates, and a second run changes nothing', { timeout: 120_000 }, async () => {
		const dir = fixture('minimal', { git: true });
		const result = await runKit3Migration(dir, { ...base, quiet: true });
		expect(result.sv.ran).toBe(true);
		expect(result.sv.failures).toEqual([]);

		const sources = fs
			.globSync('src/**/*.{ts,svelte}', { cwd: dir })
			.map((rel) => fs.readFileSync(path.join(dir, rel), 'utf8'))
			.join('\n');
		expect(sources).not.toMatch(/\$lib|\$env\/|\$app\/environment/);
		expect(fs.existsSync(path.join(dir, 'src', 'env.ts'))).toBe(true);
		expect(fs.readFileSync(path.join(dir, 'vite.config.ts'), 'utf8')).toContain('paths: { origin');
		expect(fs.readFileSync(path.join(dir, 'src/lib/server/workflows.ts'), 'utf8')).toContain(
			'Number(WORKFLOWS_CONCURRENCY || 5)'
		);
		expect(result.followUps.join('\n')).not.toContain('WORKFLOWS_CONCURRENCY');

		commitAll(dir, 'migrated');
		const before = snapshot(dir);
		const again = await runKit3Migration(dir, { ...base, quiet: true });
		expect(again.mode).toBe('repair');
		expect(snapshot(dir)).toEqual(before);
	});

	test('the vela create hook: no git, no install', { timeout: 120_000 }, async () => {
		const dir = fixture('static');
		const result = await runKit3Migration(dir, { ...base, gitCheck: false, quiet: true });
		expect(result.sv.ran).toBe(true);
		expect(readJson(dir, 'package.json').devDependencies['@sveltejs/kit']).toBe('^3.0.0');
	});
});
