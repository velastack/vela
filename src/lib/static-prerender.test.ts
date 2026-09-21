import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.join(__dirname, '../../templates/static');

function read(relative: string): string {
	return fs.readFileSync(path.join(templateDir, relative), 'utf8');
}

/** Routes the template's markup links to, as `href="/…"` absolute paths. */
function linkedRoutes(markup: string): string[] {
	const hrefs = markup.matchAll(/href="(\/[^"{#]*)"/g);
	return [...new Set([...hrefs].map((match) => match[1]!.replace(/\/$/, '') || '/'))];
}

/** The paths vite.config.ts lets prerendering 404 on. */
function allowedMissing(config: string): string[] {
	const block = config.match(/const PENDING_LEGAL_ROUTES = \[([^\]]*)\]/);
	if (!block) return [];
	return [...block[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

describe('static template prerendering', () => {
	// The template prerenders every page and crawls their links, so a link to a
	// route that does not exist yet fails `npm run build` on a fresh project.
	test('allows the legal routes vela legal has not generated yet', () => {
		expect(allowedMissing(read('vite.config.ts')).sort()).toEqual(['/privacy', '/terms']);
	});

	test('every route the footer links to either exists or is allowed to 404', () => {
		const config = read('vite.config.ts');
		const routesDir = path.join(templateDir, 'src/routes');
		const allowed = allowedMissing(config);

		const missing = linkedRoutes(read('src/routes/(public)/root-layout.svelte')).filter((route) => {
			if (route === '/') return false;
			// A route exists when some +page.svelte sits at that path, whatever
			// group directories — (public), (legal) — it is nested under.
			const pages = fs.globSync(`**/+page.svelte`, { cwd: routesDir });
			const paths = pages.map(
				(page) =>
					'/' +
					path
						.dirname(page)
						.replace(/\([^)]*\)\/?/g, '')
						.replace(/\/$/, '')
			);
			return !paths.includes(route);
		});

		expect(missing.filter((route) => !allowed.includes(route))).toEqual([]);
	});

	test('a broken link that is not a pending legal page still fails the build', () => {
		const config = read('vite.config.ts');
		// The handler rethrows anything it does not recognise, rather than
		// swallowing every 404 the crawler reports.
		expect(config).toMatch(/throw new Error\(message\)/);
		expect(config).toMatch(/status === 404 && PENDING_LEGAL_ROUTES\.includes\(path\)/);
	});
});
