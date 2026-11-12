import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	loadUrlPatternPlan,
	planUrlPatterns,
	startsChecked,
	writeUrlPatterns
} from './i18n-routes.ts';
import type { Route } from './routes.ts';

const page = (id: string, urlPattern: string): Route => ({
	id,
	urlPattern,
	methods: ['GET'],
	page: true
});

const ROUTES: Route[] = [
	page('/(public)', '/'),
	page('/(public)/about', '/about'),
	page('/(public)/blog', '/blog'),
	page('/(public)/blog/[slug]', '/blog/[slug]'),
	page('/(public)/docs/[...path]', '/docs/[...path]'),
	page('/(app)/dashboard', '/dashboard'),
	page('/(app)/teams/[id]', '/teams/[id]'),
	{ id: '/api/items', urlPattern: '/api/items', methods: ['GET'], page: false }
];

describe('planUrlPatterns', () => {
	test('one choice per page, endpoints left out', () => {
		const plan = planUrlPatterns(ROUTES, ['/']);
		expect(plan.choices.map((c) => [c.pattern, c.listed, c.app])).toEqual([
			['/', true, false],
			['/about', false, false],
			['/blog', false, false],
			['/blog/*', false, false],
			['/docs/**', false, false],
			['/dashboard', false, true],
			['/teams/*', false, true]
		]);
		expect(plan.choices[3]!.urls).toEqual(['/blog/[slug]']);
		expect(plan.covered).toEqual([]);
	});

	test('a page a broader pattern matches is reported, not offered', () => {
		const plan = planUrlPatterns(ROUTES, ['/', '/blog/**']);
		expect(plan.choices.map((c) => c.pattern)).not.toContain('/blog');
		expect(plan.covered).toEqual([
			{ url: '/blog', by: '/blog/**' },
			{ url: '/blog/[slug]', by: '/blog/**' }
		]);
	});

	test('pages that share a pattern are one choice', () => {
		const plan = planUrlPatterns(
			[page('/(public)/[slug]', '/[slug]'), page('/(app)/[id]', '/[id]')],
			[]
		);
		expect(plan.choices).toEqual([
			{ pattern: '/*', urls: ['/[slug]', '/[id]'], listed: false, app: false, broad: true }
		]);
	});

	test('what starts checked: public pages, and whatever is listed already', () => {
		const plan = planUrlPatterns(
			[
				...ROUTES,
				page('/(public)/(auth)/login', '/login'),
				page('/(public)/[slug]', '/[slug]'),
				page('/[...rest]', '/[...rest]')
			],
			['/', '/dashboard']
		);
		expect(plan.choices.filter(startsChecked).map((c) => c.pattern)).toEqual([
			'/',
			'/about',
			'/blog',
			'/blog/*',
			'/docs/**',
			'/dashboard'
		]);
		expect(plan.choices.filter((c) => c.broad).map((c) => c.pattern)).toEqual(['/*', '/**']);
		expect(plan.choices.find((c) => c.pattern === '/login')?.app).toBe(true);
	});

	test('a path with a literal wildcard character is set aside', () => {
		const plan = planUrlPatterns([page('/what[x+3f]', '/what?')], []);
		expect(plan.choices).toEqual([]);
		expect(plan.unsupported).toEqual(['/what?']);
	});
});

describe('writeUrlPatterns', () => {
	let root: string;
	let configPath: string;

	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vela-i18n-routes-test-')));
		configPath = path.join(root, 'wuchale.config.js');
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const config = (patterns: string) =>
		`export default defineConfig({ adapters: { main: svelte({ url: { localize: "src/lib/url.ts", patterns: ${patterns} } }) } });\n`;

	test('adds what was selected and removes what was unselected, leaving other entries', () => {
		fs.writeFileSync(configPath, config('["/", "/#pricing", "/about"]'));
		const plan = planUrlPatterns(ROUTES, ['/', '/#pricing', '/about']);
		const outcome = writeUrlPatterns(configPath, plan, ['/', '/blog', '/blog/*']);
		expect(outcome).toEqual({
			status: 'written',
			added: ['/blog', '/blog/*'],
			removed: ['/about']
		});
		const written = fs.readFileSync(configPath, 'utf8');
		expect(written).toMatch(/"\/",\s+"\/#pricing",\s+"\/blog",\s+"\/blog\/\*"/);
		expect(written).not.toContain('"/about"');
	});

	test('the same selection again changes nothing', () => {
		fs.writeFileSync(configPath, config('["/", "/about"]'));
		const before = fs.readFileSync(configPath, 'utf8');
		const plan = planUrlPatterns(ROUTES, ['/', '/about']);
		expect(writeUrlPatterns(configPath, plan, ['/', '/about'])).toEqual({ status: 'unchanged' });
		expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
	});

	test('loadUrlPatternPlan says what is missing', () => {
		expect(loadUrlPatternPlan(root)).toEqual({
			error: 'No wuchale config found. Run `vela enable i18n` to set up i18n.'
		});
		fs.writeFileSync(configPath, 'export default defineConfig({});\n');
		const loaded = loadUrlPatternPlan(root);
		expect('error' in loaded && loaded.error).toContain('url.patterns');
	});
});
