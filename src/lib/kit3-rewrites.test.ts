import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
	rewriteGotoOptions,
	rewriteKit3Code,
	rewriteKit3Source,
	rewriteVelaEnvDefaults,
	rewriteVelaEnvDefaultsSource
} from './kit3-rewrites.ts';

describe('rewriteGotoOptions', () => {
	test.each([
		[' noScroll: true, keepFocus: true ', ' reset: false '],
		[' keepFocus: true, noScroll: true ', ' reset: false '],
		[' noScroll: true ', ' reset: false '],
		[' noScroll: false, keepFocus: false ', ' reset: true '],
		[' replaceState: true, noScroll: true ', ' replaceState: true, reset: false '],
		[' invalidateAll: true ', ' refreshAll: true '],
		[' invalidateAll ', ' refreshAll: invalidateAll '],
		[' invalidateAll: true, refreshAll: true ', ' refreshAll: true '],
		['\n\t\tnoScroll: true,\n\t\tkeepFocus: true,\n\t', '\n\t\treset: false,\n\t'],
		[' noScroll: true, keepFocus: true, invalidateAll: true ', ' reset: false, refreshAll: true ']
	])('{%j} → {%j}', (inner, expected) => {
		const result = rewriteGotoOptions(inner);
		expect(result.task).toBeUndefined();
		expect(result.inner).toBe(expected);
		// Idempotent.
		expect(rewriteGotoOptions(result.inner).inner).toBe(result.inner);
	});

	test.each([
		[' noScroll: shouldKeep '],
		[' noScroll '],
		[' noScroll: true, keepFocus: false '],
		[' reset: false, noScroll: true ']
	])('{%j} is left with a task', (inner) => {
		const result = rewriteGotoOptions(inner);
		expect(result.inner).toBe(inner);
		expect(result.task).toBeTruthy();
	});
});

describe('rewriteKit3Source', () => {
	test('goto and invalidateAll in a component, script and markup', () => {
		const source = [
			'<script lang="ts">',
			"\timport { goto, invalidateAll } from '$app/navigation';",
			'\tasync function go() {',
			"\t\tawait goto('/x', { noScroll: true, keepFocus: true });",
			'\t\tawait invalidateAll();',
			'\t}',
			'</script>',
			'',
			"<button onclick={() => goto('/y', { invalidateAll: true })}>y</button>",
			'<button onclick={invalidateAll}>refresh</button>',
			''
		].join('\n');
		const { code, changes, tasks } = rewriteKit3Source('src/routes/+page.svelte', source);
		expect(code).toBe(
			[
				'<script lang="ts">',
				"\timport { goto, refreshAll } from '$app/navigation';",
				'\tasync function go() {',
				"\t\tawait goto('/x', { reset: false });",
				'\t\tawait refreshAll();',
				'\t}',
				'</script>',
				'',
				"<button onclick={() => goto('/y', { refreshAll: true })}>y</button>",
				'<button onclick={refreshAll}>refresh</button>',
				''
			].join('\n')
		);
		expect(changes).toHaveLength(3);
		expect(tasks).toEqual([]);
		expect(rewriteKit3Source('src/routes/+page.svelte', code).code).toBe(code);
	});

	test('an aliased goto, and a goto that is not $app/navigation’s', () => {
		const source = [
			"import { goto as navigate } from '$app/navigation';",
			"navigate('/a', { noScroll: true });",
			"router.goto('/b', { noScroll: true });"
		].join('\n');
		expect(rewriteKit3Source('a.ts', source).code).toBe(
			[
				"import { goto as navigate } from '$app/navigation';",
				"navigate('/a', { reset: false });",
				"router.goto('/b', { noScroll: true });"
			].join('\n')
		);
	});

	test('invalidateAll with refreshAll already imported drops the duplicate', () => {
		const source =
			"import { invalidateAll, refreshAll } from '$app/navigation';\nawait invalidateAll();\n";
		expect(rewriteKit3Source('a.ts', source).code).toBe(
			"import { refreshAll } from '$app/navigation';\nawait refreshAll();\n"
		);
	});

	test('superForm’s own invalidateAll option is not touched', () => {
		const source = [
			"import { invalidateAll } from '$app/navigation';",
			"const form = superForm(data.form, { invalidateAll: 'force' });",
			'await invalidateAll();'
		].join('\n');
		const { code } = rewriteKit3Source('a.ts', source);
		expect(code).toContain("superForm(data.form, { invalidateAll: 'force' })");
		expect(code).toContain('await refreshAll();');
	});

	test('a file using page.state keeps invalidateAll and gets one task comment', () => {
		const source = [
			"import { invalidateAll, pushState } from '$app/navigation';",
			"pushState('', { open: true });",
			'await invalidateAll();',
			''
		].join('\n');
		const first = rewriteKit3Source('a.ts', source);
		expect(first.code).toContain('await invalidateAll();');
		expect(first.code.split('\n')[0]).toMatch(/^\/\/ @migration-task .*refreshAll/);
		expect(first.tasks).toHaveLength(1);
		const second = rewriteKit3Source('a.ts', first.code);
		expect(second.code).toBe(first.code);
		expect(second.tasks).toEqual([]);
	});

	test('a goto whose options cannot be rewritten gets a task in markup', () => {
		const source = [
			'<script>',
			"\timport { goto } from '$app/navigation';",
			'\tlet keep = $state(true);',
			'</script>',
			'',
			"<a onclick={() => goto('/x', { noScroll: keep })}>x</a>",
			''
		].join('\n');
		const first = rewriteKit3Source('src/routes/+page.svelte', source);
		expect(
			first.code.startsWith(
				"<!-- @migration-task `<a onclick={() => goto('/x', { noScroll: keep })}>x</a>`:"
			)
		).toBe(true);
		expect(rewriteKit3Source('src/routes/+page.svelte', first.code).code).toBe(first.code);
	});

	test('vi.mock and vi.doMock of $app/environment, and new URL(page.url)', () => {
		const source = [
			"vi.mock('$app/environment', () => ({ browser: false }));",
			'vi.doMock("$app/environment", () => ({ dev: true }));',
			'const url = new URL(page.url);'
		].join('\n');
		const { code } = rewriteKit3Source('src/a.test.ts', source);
		expect(code).toBe(
			[
				"vi.mock('$app/env', () => ({ browser: false }));",
				'vi.doMock("$app/env", () => ({ dev: true }));',
				'const url = new URL(page.url.href);'
			].join('\n')
		);
	});
});

describe('rewriteKit3Code', () => {
	let dir: string;
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	test('src and test; a second run changes nothing', () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-kit3-rewrites-'));
		fs.mkdirSync(path.join(dir, 'src/routes'), { recursive: true });
		fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'src/routes/+page.svelte'),
			"<script>\n\timport { goto } from '$app/navigation';\n</script>\n\n<a onclick={() => goto('/', { noScroll: true })}>x</a>\n"
		);
		fs.writeFileSync(
			path.join(dir, 'test/setup.ts'),
			"vi.doMock('$app/environment', () => ({ building: false }));\n"
		);
		const first = rewriteKit3Code(dir);
		expect(first.map((r) => r.file).sort()).toEqual(['src/routes/+page.svelte', 'test/setup.ts']);
		expect(rewriteKit3Code(dir)).toEqual([]);
	});
});

describe('rewriteVelaEnvDefaultsSource', () => {
	test("vela variables from $app/env/*: ?? <default> → || <default>, ?? '' left alone", () => {
		const source = [
			"import { WORKFLOWS_CONCURRENCY, POCKETBASE_URL, TEST as IS_TEST } from '$app/env/private';",
			"import { STRIPE_SECRET_KEY } from '$app/env/private';",
			"const url = POCKETBASE_URL ?? '';",
			'const n = Number(WORKFLOWS_CONCURRENCY ?? 5);',
			"const testing = (IS_TEST ?? 'false') === 'true';",
			"const key = STRIPE_SECRET_KEY ?? 'sk_test';",
			'// WORKFLOWS_CONCURRENCY ?? 5 in a comment',
			"const sum = 1 + WORKFLOWS_CONCURRENCY ?? '2';",
			'const chained = WORKFLOWS_CONCURRENCY ?? fallback ?? 5;',
			''
		].join('\n');
		const { code, changes } = rewriteVelaEnvDefaultsSource(source);
		expect(code).toBe(
			source
				.replace('WORKFLOWS_CONCURRENCY ?? 5)', 'WORKFLOWS_CONCURRENCY || 5)')
				.replace("IS_TEST ?? 'false'", "IS_TEST || 'false'")
		);
		expect(changes).toEqual([
			'line 4: WORKFLOWS_CONCURRENCY ?? 5 → WORKFLOWS_CONCURRENCY || 5',
			"line 5: IS_TEST ?? 'false' → IS_TEST || 'false'"
		]);
		expect(rewriteVelaEnvDefaultsSource(code).code).toBe(code);
	});

	test('the $env/* aliases and other variables are not touched', () => {
		const source = [
			"import { env } from '$env/dynamic/private';",
			"import { WORKFLOWS_CONCURRENCY } from '$env/static/private';",
			"import { PUBLIC_CMS_URL } from '$app/env/public';",
			'const a = Number(env.WORKFLOWS_CONCURRENCY ?? 5);',
			'const b = Number(WORKFLOWS_CONCURRENCY ?? 5);',
			"const c = PUBLIC_CMS_URL ?? 'https://cms.test';",
			''
		].join('\n');
		expect(rewriteVelaEnvDefaultsSource(source)).toEqual({ code: source, changes: [] });
	});

	test('svelte markup and a public import', () => {
		const source = [
			'<script lang="ts">',
			"\timport { TEST } from '$app/env/public';",
			'</script>',
			'',
			"<p>{TEST ?? 'no'}</p>",
			''
		].join('\n');
		expect(rewriteVelaEnvDefaultsSource(source).code).toContain("{TEST || 'no'}");
	});
});

describe('rewriteVelaEnvDefaults', () => {
	let dir: string;
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	test('src only; a second run changes nothing', () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-env-defaults-'));
		fs.mkdirSync(path.join(dir, 'src/lib/server'), { recursive: true });
		fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
		const source =
			"import { WORKFLOWS_CONCURRENCY } from '$app/env/private';\nexport const n = Number(WORKFLOWS_CONCURRENCY ?? 5);\n";
		fs.writeFileSync(path.join(dir, 'src/lib/server/workflows.ts'), source);
		fs.writeFileSync(path.join(dir, 'test/setup.ts'), source);
		expect(rewriteVelaEnvDefaults(dir)).toEqual([
			{
				file: path.join('src', 'lib', 'server', 'workflows.ts'),
				changes: ['line 2: WORKFLOWS_CONCURRENCY ?? 5 → WORKFLOWS_CONCURRENCY || 5'],
				tasks: []
			}
		]);
		expect(fs.readFileSync(path.join(dir, 'src/lib/server/workflows.ts'), 'utf8')).toContain(
			'Number(WORKFLOWS_CONCURRENCY || 5)'
		);
		expect(fs.readFileSync(path.join(dir, 'test/setup.ts'), 'utf8')).toBe(source);
		expect(rewriteVelaEnvDefaults(dir)).toEqual([]);
	});
});
