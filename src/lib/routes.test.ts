import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	classifyRouteFile,
	exportedNames,
	listRoutes,
	readRouteConfig,
	routeUrl
} from './routes.ts';

let root: string;

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vela-routes-test-')));
	fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content = ''): void {
	const file = path.join(root, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

const summary = () =>
	listRoutes(root).map((route) => `${route.urlPattern} ${route.methods.join(',')} ${route.id}`);

describe('classifyRouteFile', () => {
	const svelte = ['.svelte'];

	test('a page, with or without a layout reset', () => {
		expect(classifyRouteFile('+page.svelte', svelte)).toEqual({ kind: 'page' });
		expect(classifyRouteFile('+page@.svelte', svelte)).toEqual({ kind: 'page' });
		expect(classifyRouteFile('+page@(app).svelte', svelte)).toEqual({ kind: 'page' });
	});

	test('modules', () => {
		expect(classifyRouteFile('+server.ts', svelte)).toEqual({ kind: 'endpoint' });
		expect(classifyRouteFile('+server.js', svelte)).toEqual({ kind: 'endpoint' });
		expect(classifyRouteFile('+page.server.ts', svelte)).toEqual({ kind: 'page-server' });
		expect(classifyRouteFile('+page.ts', svelte)).toEqual({ kind: 'page' });
		expect(classifyRouteFile('+layout.server.ts', svelte)).toEqual({ kind: 'other' });
		expect(classifyRouteFile('+layout@(app).svelte', svelte)).toEqual({ kind: 'other' });
		expect(classifyRouteFile('+error.svelte', svelte)).toEqual({ kind: 'other' });
	});

	test('files SvelteKit leaves out of the route tree', () => {
		for (const name of [
			'page.svelte',
			'+page.test.ts',
			'+server.spec.ts',
			'+page.stories.svelte',
			'+page.server.d.ts',
			'+page.svelte.ts',
			'README.md'
		]) {
			expect(classifyRouteFile(name, svelte), name).toBeNull();
		}
	});

	test('a configured extension is a page; an unconfigured one is not', () => {
		expect(classifyRouteFile('+page.svx', ['.svelte', '.svx'])).toEqual({ kind: 'page' });
		expect(classifyRouteFile('+page.svx', svelte)).toBeNull();
	});

	test('with extensions that could not be read, any non-module +page is one', () => {
		expect(classifyRouteFile('+page.svx', null)).toEqual({ kind: 'page' });
		expect(classifyRouteFile('+page@.md', null)).toEqual({ kind: 'page' });
		expect(classifyRouteFile('+page.server.ts', null)).toEqual({ kind: 'page-server' });
		expect(classifyRouteFile('+layout.svx', null)).toBeNull();
	});
});

describe('exportedNames', () => {
	test('every way a module can export a name', () => {
		const source = `
			// export const PATCH = 1;
			const url = "https://example.com"; export const GET = () => {};
			export async function POST() {}
			export function* PUT() {}
			export const { DELETE, x: OPTIONS } = handlers;
			const head = () => {};
			export { head as HEAD, local };
			export { QUERY } from './query.js';
			export let prerender = true, fallback = () => {};
			const actions = {};
			export default {};
		`;
		expect(exportedNames(source).sort()).toEqual(
			[
				'GET',
				'POST',
				'PUT',
				'DELETE',
				'OPTIONS',
				'HEAD',
				'local',
				'QUERY',
				'prerender',
				'fallback'
			].sort()
		);
	});
});

describe('routeUrl', () => {
	test('drops groups and decodes escapes', () => {
		expect(routeUrl('/')).toBe('/');
		expect(routeUrl('/(public)')).toBe('/');
		expect(routeUrl('/(public)/(auth)/login')).toBe('/login');
		expect(routeUrl('/[x+2e]well-known/[u+1f600]')).toBe('/.well-known/😀');
		expect(routeUrl('/blog/[slug]/[[page]]/[...rest]')).toBe('/blog/[slug]/[[page]]/[...rest]');
	});
});

describe('listRoutes', () => {
	test('pages, form actions and endpoints', () => {
		write('src/routes/+layout.svelte');
		write('src/routes/(public)/+page.svelte');
		write('src/routes/(public)/contact/+page.svelte');
		write('src/routes/(public)/contact/+page.server.ts', 'export const actions = {};');
		write('src/routes/(app)/dashboard/+page@(app).svelte');
		write('src/routes/api/items/+server.ts', 'export const GET = 1; export function QUERY() {}');
		write('src/routes/api/items/+server.test.ts', 'export const DELETE = 1;');
		// A layout alone is not something a request can reach.
		write('src/routes/(app)/settings/+layout.server.ts', 'export const load = () => {};');
		// A route that only redirects has no component, and is still a page.
		write('src/routes/(app)/logout/+page.server.ts', 'export const load = () => {};');
		// A load function that happens to be called GET is not a method.
		write('src/routes/(public)/about/+page.svelte');
		write('src/routes/(public)/about/+page.server.ts', 'export const GET = 1;');

		expect(summary()).toEqual([
			'/ GET /(public)',
			'/about GET /(public)/about',
			'/api/items GET,QUERY /api/items',
			'/contact GET,POST /(public)/contact',
			'/dashboard GET /(app)/dashboard',
			'/logout GET /(app)/logout'
		]);
		expect(
			listRoutes(root)
				.filter((route) => route.page)
				.map((route) => route.id)
		).toEqual([
			'/(public)',
			'/(public)/about',
			'/(public)/contact',
			'/(app)/dashboard',
			'/(app)/logout'
		]);
	});

	test('follows a symlinked directory', () => {
		write('shared/docs/+page.svelte');
		write('src/routes/+page.svelte');
		fs.symlinkSync(path.join(root, 'shared/docs'), path.join(root, 'src/routes/docs'), 'dir');
		fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'src/routes/gone'), 'dir');
		expect(summary()).toEqual(['/ GET /', '/docs GET /docs']);
	});

	test('reads the routes directory and extensions from the inline sveltekit config', () => {
		write(
			'vite.config.ts',
			`import { sveltekit } from '@sveltejs/kit/vite';
export default { plugins: [sveltekit({ extensions: ['.svelte', '.svx'], files: { routes: 'app/pages' } })] };
`
		);
		write('app/pages/+page.svx');
		write('app/pages/guide/+page.svelte');
		write('src/routes/ignored/+page.svelte');
		expect(readRouteConfig(root)).toEqual({
			routesDir: path.join('app', 'pages'),
			extensions: ['.svelte', '.svx']
		});
		expect(summary()).toEqual(['/ GET /', '/guide GET /guide']);
	});

	test('extensions built at run time are not guessed at, and other pages still count', () => {
		write(
			'vite.config.ts',
			`import { sveltekit } from '@sveltejs/kit/vite';
export default { plugins: [sveltekit({ extensions: ['.svelte', ...mdsvex.extensions] })] };
`
		);
		write('src/routes/tutorials/intro/+page.svx');
		expect(readRouteConfig(root).extensions).toBeNull();
		expect(summary()).toEqual(['/tutorials/intro GET /tutorials/intro']);
	});

	test('no routes directory is no routes', () => {
		expect(listRoutes(root)).toEqual([]);
	});
});
