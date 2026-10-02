import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
	rewriteComponentsJsonAliases,
	rewriteLibOutsideSrc,
	rewriteLibSpecifiers,
	toLibSpecifier
} from './lib-rewrite.ts';
import { copyKit2Fixture, snapshot } from './kit2-fixture.ts';

let dir: string;

afterEach(() => {
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string) {
	fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), content);
}

describe('toLibSpecifier', () => {
	test.each([
		['$lib', '#lib'],
		['$lib/site', '#lib/site.js'],
		['$lib/site.js', '#lib/site.js'],
		['$lib/utils.js', '#lib/utils.js'],
		['$lib/server/workflows', '#lib/server/workflows.js'],
		['$lib/components/ui/button', '#lib/components/ui/button/index.js'],
		['$lib/components/ui/button/button.svelte', '#lib/components/ui/button/button.svelte'],
		['$lib/missing', null]
	])('%s → %s', (spec, expected) => {
		dir = copyKit2Fixture('minimal');
		expect(toLibSpecifier(dir, spec)).toBe(expected);
	});

	test('a rune module named without its .ts', () => {
		dir = copyKit2Fixture('minimal');
		write('src/lib/state.svelte.ts', 'export const x = $state(0);\n');
		expect(toLibSpecifier(dir, '$lib/state.svelte')).toBe('#lib/state.svelte.js');
	});
});

describe('rewriteLibSpecifiers', () => {
	test('rewrites imports, dynamic imports and vi.mock, and nothing in plain strings', () => {
		dir = copyKit2Fixture('minimal');
		const source = [
			"import { site } from '$lib/site';",
			"import type { X } from '$lib/utils';",
			"import '$lib/server/workflows';",
			"const m = await import('$lib/site');",
			"vi.mock('$lib/server/workflows', () => ({}));",
			"const label = 'see $lib/site';"
		].join('\n');
		const { code, unresolved } = rewriteLibSpecifiers(dir, source);
		expect(code).toBe(
			[
				"import { site } from '#lib/site.js';",
				"import type { X } from '#lib/utils.js';",
				"import '#lib/server/workflows.js';",
				"const m = await import('#lib/site.js');",
				"vi.mock('#lib/server/workflows.js', () => ({}));",
				"const label = 'see $lib/site';"
			].join('\n')
		);
		expect(unresolved).toEqual([]);
	});
});

describe('rewriteLibOutsideSrc', () => {
	test('test/**, vitest.config and root files; a second run changes nothing', () => {
		dir = copyKit2Fixture('minimal');
		write('test/helpers.ts', "import { site } from '$lib/site';\nexport { site };\n");
		write(
			'vitest.config.ts',
			fs.readFileSync(path.join(dir, 'vitest.config.ts'), 'utf8') +
				"\nimport { cn } from '$lib/utils';\nvoid cn;\n"
		);
		write('seed.ts', "import { site } from '$lib/site.js';\nimport x from '$lib/nope';\n");
		// Under src/ is sv's job, not this one's.
		write('src/routes/x.ts', "import { site } from '$lib/site';\n");

		const first = rewriteLibOutsideSrc(dir);
		expect(first.rewritten.map((r) => r.file).sort()).toEqual([
			'seed.ts',
			'test/helpers.ts',
			'vitest.config.ts'
		]);
		expect(fs.readFileSync(path.join(dir, 'test/helpers.ts'), 'utf8')).toContain(
			"from '#lib/site.js'"
		);
		expect(fs.readFileSync(path.join(dir, 'src/routes/x.ts'), 'utf8')).toContain("'$lib/site'");
		expect(first.unresolved).toEqual(['seed.ts: $lib/nope']);

		const before = snapshot(dir);
		const second = rewriteLibOutsideSrc(dir);
		expect(second.rewritten).toEqual([]);
		expect(snapshot(dir)).toEqual(before);
	});
});

describe('rewriteComponentsJsonAliases', () => {
	test('aliases name directories; formatting kept; a second run changes nothing', () => {
		dir = copyKit2Fixture('minimal');
		const original = fs.readFileSync(path.join(dir, 'components.json'), 'utf8');
		const result = rewriteComponentsJsonAliases(dir);
		const after = fs.readFileSync(path.join(dir, 'components.json'), 'utf8');
		expect(result?.changes).toContain('$lib/components/ui → #lib/components/ui');
		expect(JSON.parse(after).aliases).toEqual({
			components: '#lib/components',
			utils: '#lib/utils',
			ui: '#lib/components/ui',
			hooks: '#lib/hooks',
			lib: '#lib'
		});
		// Only the alias values changed.
		expect(after.replaceAll('#lib', '$lib')).toBe(original);
		expect(rewriteComponentsJsonAliases(dir)).toBeNull();
	});
});
