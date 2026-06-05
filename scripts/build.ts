import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context } from 'esbuild';
import pkg from '../package.json' with { type: 'json' };

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const nodeBuiltinIds = new Set<string>();
for (const name of builtinModules) {
	nodeBuiltinIds.add(name);
	nodeBuiltinIds.add(`node:${name}`);
}

const externalNames = [
	...Object.keys(pkg.dependencies ?? {}),
	...Object.keys(pkg.peerDependencies ?? {})
];

const watch = process.argv.includes('--watch');

const ctx = await context({
	entryPoints: [resolve(root, 'src/bin.ts')],
	outfile: resolve(root, 'dist/bin.js'),
	bundle: true,
	platform: 'node',
	target: 'node20',
	format: 'esm',
	sourcemap: true,
	banner: { js: '#!/usr/bin/env node' },
	external: [...nodeBuiltinIds, ...externalNames],
	logLevel: 'info'
});

if (watch) {
	await ctx.watch();
	console.log('Watching for changes...');
} else {
	await ctx.rebuild();
	await ctx.dispose();
}
