import fs from 'node:fs';
import path from 'node:path';

const VANILLA_MARKER = 'Welcome to SvelteKit';
const PAGE_REL = path.join('src', 'routes', '+page.svelte');

export function isVanillaRoutes(cwd: string): boolean {
	const pagePath = path.join(cwd, PAGE_REL);
	if (!fs.existsSync(pagePath)) return false;
	return fs.readFileSync(pagePath, 'utf8').includes(VANILLA_MARKER);
}
