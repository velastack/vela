import { listRoutes } from './routes.ts';

const LEGAL_PAGES = [
	{ url: '/terms', command: 'vela legal terms' },
	{ url: '/privacy', command: 'vela legal privacy' }
];

/**
 * The next step for the legal pages the auth pages link to, when the project
 * does not have them: the generated login and signup pages and the public
 * footer link to `/terms` and `/privacy`, which only exist once `vela legal`
 * has written them. Empty when both routes are there (or cannot be read).
 */
export function missingLegalSteps(root: string | null): string[] {
	if (!root) return [];
	let urls: Set<string>;
	try {
		urls = new Set(listRoutes(root).map((route) => route.urlPattern));
	} catch {
		return [];
	}
	const missing = LEGAL_PAGES.filter((page) => !urls.has(page.url));
	if (missing.length === 0) return [];

	const pages = missing.map((page) => page.url).join(' and ');
	const commands = missing.map((page) => `\`${page.command}\``).join(' and ');
	return [
		`The login and signup pages and the public footer link to ${pages}, which ${missing.length === 1 ? 'does' : 'do'} not exist yet. Run ${commands} to write ${missing.length === 1 ? 'it' : 'them'}.`
	];
}
