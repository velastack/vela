import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context, type BuildOptions } from 'esbuild';
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

const shared: BuildOptions = {
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'esm',
	sourcemap: true,
	external: [...nodeBuiltinIds, ...externalNames],
	logLevel: 'info'
};

const contexts = await Promise.all([
	context({
		...shared,
		entryPoints: [resolve(root, 'src/bin.ts')],
		outfile: resolve(root, 'dist/bin.js'),
		banner: { js: '#!/usr/bin/env node' }
	}),
	// `vela/testing`: the vitest global setup a project imports. Built apart
	// from the bin so it carries no shebang and none of the CLI.
	context({
		...shared,
		entryPoints: [resolve(root, 'src/testing.ts')],
		outfile: resolve(root, 'dist/testing.js')
	})
]);

if (watch) {
	await Promise.all(contexts.map((ctx) => ctx.watch()));
	console.log('Watching for changes...');
} else {
	for (const ctx of contexts) {
		await ctx.rebuild();
		await ctx.dispose();
	}
}
