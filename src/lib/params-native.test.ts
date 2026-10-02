import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { captureParamTypeImports, fixParamsImports } from './params-native.ts';

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-params-'));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
	const file = path.join(tmp, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function read(rel: string): string {
	return fs.readFileSync(path.join(tmp, rel), 'utf8');
}

/** velastack.dev's matchers and the modules they import, at 24c9a86 (trimmed). */
function velastack(): void {
	write(
		'package.json',
		JSON.stringify({ type: 'module', imports: { '#lib/*': './src/lib/*' } }, null, '\t')
	);
	write(
		'src/params/country.ts',
		"import type { ParamMatcher } from '@sveltejs/kit';\nimport { isCountryCode, type CountryCode } from '$lib/velabase/landing/countries.js';\n\nexport const match = ((param: string): param is CountryCode =>\n\tisCountryCode(param)) satisfies ParamMatcher;\n"
	);
	write(
		'src/params/industry.ts',
		"import type { ParamMatcher } from '@sveltejs/kit';\nimport { industryFromSlug } from '$lib/velabase/landing/slugs';\n\nexport const match = ((param: string) => industryFromSlug(param) !== null) satisfies ParamMatcher;\n"
	);
	// Plain JS so wuchale.config.js can import it; the type is a JSDoc typedef.
	write(
		'src/lib/velabase/landing/countries.js',
		"// @ts-check\nexport const COUNTRY_CODES = /** @type {const} */ (['mx', 'gt']);\n/** @typedef {(typeof COUNTRY_CODES)[number]} CountryCode */\n/** @param {string} code @returns {code is CountryCode} */\nexport function isCountryCode(code) {\n\treturn COUNTRY_CODES.includes(/** @type {CountryCode} */ (code));\n}\n"
	);
	write(
		'src/lib/velabase/landing/slugs.ts',
		"import type { Locale } from '#locales/data.js';\n\nexport type IndustryId = 'bakery';\nexport function industryFromSlug(slug: string): IndustryId | null {\n\treturn slug === 'panaderia' ? 'bakery' : null;\n}\nexport const locales: Locale[] = [];\n"
	);
	// What sv 1.0.1 folded them into: `type` gone from CountryCode.
	write(
		'src/params.ts',
		"import { defineParams } from '@sveltejs/kit/params';\nimport { isCountryCode, CountryCode } from '#lib/velabase/landing/countries.js';\nimport { industryFromSlug } from '#lib/velabase/landing/slugs.js';\n\nconst matchCountry = (param: string): param is CountryCode => isCountryCode(param);\n\nexport const params = defineParams({\n\tcountry: (param) => (matchCountry(param) ? param : undefined),\n\tindustry: (param) => (industryFromSlug(param) !== null ? param : undefined)\n});\n"
	);
}

describe('captureParamTypeImports', () => {
	test('the names src/params/* imports as types', () => {
		velastack();
		write(
			'src/params/x.ts',
			"import type { A, B as C } from './a.js';\nimport { d, type E } from './b.js';\n"
		);
		expect([...captureParamTypeImports(tmp)].sort()).toEqual([
			'A',
			'C',
			'CountryCode',
			'E',
			'ParamMatcher'
		]);
	});
});

describe('fixParamsImports', () => {
	test('velastack.dev: type restored, #lib to a .ts file made relative; a second run changes nothing', () => {
		velastack();
		const outcome = fixParamsImports(tmp, captureParamTypeImports(tmp));
		expect(outcome.file).toBe('src/params.ts');
		expect(read('src/params.ts')).toContain(
			"import { isCountryCode, type CountryCode } from '#lib/velabase/landing/countries.js';\nimport { industryFromSlug } from './lib/velabase/landing/slugs.ts';\n"
		);
		expect(outcome.changes).toEqual([
			'type CountryCode (from #lib/velabase/landing/countries.js)',
			'#lib/velabase/landing/slugs.js → ./lib/velabase/landing/slugs.ts'
		]);
		// slugs.ts imports #locales only as a type, which Node never sees.
		expect(outcome.viteOnly).toEqual([]);

		const after = read('src/params.ts');
		expect(fixParamsImports(tmp, captureParamTypeImports(tmp)).changes).toEqual([]);
		expect(read('src/params.ts')).toBe(after);
	});

	test('without the matchers (a later run), the JSDoc typedef still says CountryCode is a type', () => {
		velastack();
		fs.rmSync(path.join(tmp, 'src/params'), { recursive: true });
		fixParamsImports(tmp);
		expect(read('src/params.ts')).toContain('{ isCountryCode, type CountryCode }');
	});

	test('an import of only types becomes `import type`, which Node erases', () => {
		velastack();
		write(
			'src/params.ts',
			"import { IndustryId } from '#lib/velabase/landing/slugs.js';\nexport const params = {} as Record<IndustryId, never>;\n"
		);
		fixParamsImports(tmp);
		expect(read('src/params.ts')).toContain(
			"import type { IndustryId } from '#lib/velabase/landing/slugs.js';"
		);
	});

	test('lists what the modules it loads import that only Vite resolves', () => {
		velastack();
		write(
			'src/lib/velabase/landing/slugs.ts',
			"import { site } from '$lib/site';\nimport { x } from '#lib/x.js';\nexport function industryFromSlug(slug: string) {\n\treturn site && x ? slug : null;\n}\n"
		);
		write('src/lib/x.ts', 'export const x = 1;\n');
		expect(fixParamsImports(tmp).viteOnly).toEqual([
			'src/lib/velabase/landing/slugs.ts: $lib/site',
			'src/lib/velabase/landing/slugs.ts: #lib/x.js'
		]);
	});

	test('no params file, nothing to do', () => {
		expect(fixParamsImports(tmp)).toEqual({ changes: [], viteOnly: [] });
	});

	const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
	test.skipIf(major < 22 || (major === 22 && minor < 18))(
		'the result loads under plain Node, as SvelteKit 3 loads it',
		() => {
			velastack();
			write(
				'node_modules/@sveltejs/kit/package.json',
				JSON.stringify({
					name: '@sveltejs/kit',
					type: 'module',
					exports: { './params': './params.js' }
				})
			);
			write('node_modules/@sveltejs/kit/params.js', 'export const defineParams = (p) => p;\n');
			const load = () =>
				execFileSync(
					process.execPath,
					[
						'--input-type=module',
						'-e',
						"const m = await import('./src/params.ts'); console.log(Object.keys(m.params).join(','))"
					],
					{ cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
				);
			expect(load).toThrow();
			fixParamsImports(tmp, captureParamTypeImports(tmp));
			expect(load().trim()).toBe('country,industry');
		}
	);
});
