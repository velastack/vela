import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { getWorkspace } from '../lib/workspace.ts';

interface Route {
	id: string;
	urlPattern: string;
	methods: string[];
}

const HTTP_METHODS = new Set([
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
	'OPTIONS',
	'HEAD',
	'fallback'
]);

export const routes = new Command('routes')
	.description('list routes')
	.configureHelp(helpConfig)
	.action(async () => {
		const { workspaceRootDir, routesDir } = await getWorkspace();
		const routesRoot = path.join(workspaceRootDir, routesDir);
		const found = walk(routesRoot, routesRoot).filter((r) => r.methods.length > 0);
		found.sort((a, b) => a.urlPattern.localeCompare(b.urlPattern));
		printTable(found);
	});

function walk(root: string, dir: string): Route[] {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	const routes: Route[] = [];

	const hasLeaf = entries.some((e) => e.isFile() && isRouteFile(e.name));
	if (hasLeaf) {
		const id = '/' + path.relative(root, dir).split(path.sep).filter(Boolean).join('/');
		const urlPattern = id.replace(/\([^)]+\)\/?/g, '').replace(/\/$/, '') || '/';
		const methods = new Set<string>();
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			if (entry.name.endsWith('+page.svelte')) methods.add('GET');
			if (
				entry.name.endsWith('+server.ts') ||
				entry.name.endsWith('+server.js') ||
				entry.name.endsWith('+page.server.ts') ||
				entry.name.endsWith('+page.server.js')
			) {
				extractMethods(path.join(dir, entry.name)).forEach((m) => methods.add(m));
			}
		}
		routes.push({ id: id || '/', urlPattern, methods: [...methods] });
	}

	for (const entry of entries) {
		if (entry.isDirectory()) routes.push(...walk(root, path.join(dir, entry.name)));
	}
	return routes;
}

function isRouteFile(name: string): boolean {
	return (
		name.startsWith('+page.') || name.startsWith('+server.') || name.startsWith('+layout.server.')
	);
}

function extractMethods(file: string): string[] {
	try {
		const content = fs.readFileSync(file, 'utf8');
		const methods: string[] = [];
		const exportRegex = /export\s+(?:const|async\s+function|function)\s+(\w+)/g;
		let match: RegExpExecArray | null;
		while ((match = exportRegex.exec(content)) !== null) {
			const name = match[1]!;
			if (HTTP_METHODS.has(name)) methods.push(name);
			if (name === 'actions') methods.push('POST');
		}
		return methods;
	} catch {
		return [];
	}
}

function printTable(routes: Route[]): void {
	if (routes.length === 0) {
		console.log('No routes found.');
		return;
	}
	const urlWidth = Math.max(...routes.map((r) => r.urlPattern.length), 3) + 2;
	const methodsWidth = 30;
	const idWidth = Math.max(...routes.map((r) => r.id.length), 2) + 2;

	const line = (a: string, b: string, c: string) =>
		'┌' + '─'.repeat(urlWidth) + a + '─'.repeat(methodsWidth) + b + '─'.repeat(idWidth) + c;
	console.log(line('┬', '┬', '┐'));
	console.log(
		'│ ' +
			'URL'.padEnd(urlWidth - 2) +
			' │ ' +
			'Methods'.padEnd(methodsWidth - 2) +
			' │ ' +
			'ID'.padEnd(idWidth - 2) +
			' │'
	);
	console.log(
		'├' + '─'.repeat(urlWidth) + '┼' + '─'.repeat(methodsWidth) + '┼' + '─'.repeat(idWidth) + '┤'
	);
	for (const r of routes) {
		console.log(
			'│ ' +
				r.urlPattern.padEnd(urlWidth - 2) +
				' │ ' +
				r.methods.join(', ').padEnd(methodsWidth - 2) +
				' │ ' +
				r.id.padEnd(idWidth - 2) +
				' │'
		);
	}
	console.log(
		'└' + '─'.repeat(urlWidth) + '┴' + '─'.repeat(methodsWidth) + '┴' + '─'.repeat(idWidth) + '┘'
	);
}
