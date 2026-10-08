import fs from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.mts', '.mjs', '.svelte']);

const STATIC_IMPORT =
	/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]\$env\/static\/(?:private|public)['"]/g;

/**
 * The names a project imports from `$env/static/*`.
 *
 * Those are read once, at build time, and baked into the bundle: setting one on
 * the server changes nothing until the next deploy, and a build that cannot see
 * one fails. Both are worth knowing before the command that would otherwise
 * report a restart, or ship a bundle with a developer's value in it.
 */
export function staticEnvImports(root: string): Set<string> {
	const names = new Set<string>();
	const src = path.join(root, 'src');
	if (!fs.existsSync(src)) return names;

	for (const file of sourceFiles(src)) {
		const content = fs.readFileSync(file, 'utf8');
		if (!content.includes('$env/static/')) continue;
		for (const match of content.matchAll(STATIC_IMPORT)) {
			for (const spec of match[1]!.split(',')) {
				// `FOO as bar` imports FOO; a type-only specifier is still a read.
				const name = spec
					.trim()
					.replace(/^type\s+/, '')
					.split(/\s+as\s+/)[0]
					?.trim();
				if (name) names.add(name);
			}
		}
	}
	return names;
}

function* sourceFiles(dir: string): Generator<string> {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* sourceFiles(full);
		else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) yield full;
	}
}
