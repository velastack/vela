import { Command } from 'commander';
import { helpConfig } from '../lib/help.ts';
import { listRoutes, type Route } from '../lib/routes.ts';
import { runCommand } from '../lib/run.ts';
import { findWorkspaceRoot } from '../lib/workspace.ts';

export const routes = new Command('routes')
	.description('list routes')
	.configureHelp(helpConfig)
	.action(() =>
		runCommand(() => {
			const root = findWorkspaceRoot();
			if (!root) throw new Error('Could not find workspace root (no package.json found)');
			printTable(listRoutes(root));
		})
	);

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
