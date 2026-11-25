import { describe, expect, test } from 'vitest';
import { RENDER_PAGES_ENV, stubPagesPlugin, testPlugins } from './test-harness.ts';
import { TEST_SERVER_HELP } from '../commands/test.ts';

describe('testPlugins', () => {
	test('pages are stubbed by default', () => {
		expect(testPlugins({}).map((plugin) => plugin.name)).toEqual(['stub-pages']);
	});

	test.each(['1', 'true', 'TRUE', ' 1 '])('%j serves the real pages', (value) => {
		expect(testPlugins({ [RENDER_PAGES_ENV]: value })).toEqual([]);
	});

	test.each(['', '0', 'false', 'no'])('%j keeps the stubs', (value) => {
		expect(testPlugins({ [RENDER_PAGES_ENV]: value })).toHaveLength(1);
	});

	test('the variable is the documented one', () => {
		expect(RENDER_PAGES_ENV).toBe('VELA_TEST_RENDER_PAGES');
		expect(TEST_SERVER_HELP).toContain('VELA_TEST_RENDER_PAGES=1');
		expect(TEST_SERVER_HELP).toMatch(/empty body/);
	});
});

describe('stubPagesPlugin', () => {
	const plugin = stubPagesPlugin() as unknown as {
		load(id: string): string | undefined;
	};

	test('pages and error pages render nothing', () => {
		expect(plugin.load('/app/src/routes/+page.svelte')).toContain("render = () => ''");
		expect(plugin.load('/app/src/routes/+page@.svelte')).toBeDefined();
		expect(plugin.load('/app/src/routes/+error.svelte')).toBeDefined();
	});

	test('a layout still renders its children', () => {
		expect(plugin.load('/app/src/routes/+layout.svelte')).toContain('{@render children?.()}');
		expect(plugin.load('/app/src/routes/+layout@(app).svelte')).toBeDefined();
	});

	test('everything else is left to Vite', () => {
		expect(plugin.load('/app/src/lib/Button.svelte')).toBeUndefined();
		expect(plugin.load('/app/src/routes/+page.server.ts')).toBeUndefined();
	});
});
