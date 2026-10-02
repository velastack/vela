import fs from 'node:fs';
import path from 'node:path';
import { libSpecifier } from '@velastack/patterns';

/**
 * `$lib` outside `src/`, which `sv migrate sveltekit-3` leaves alone: its
 * `lib-alias` task rewrites `src/**` only. SvelteKit 3 has no `$lib`, so a
 * `test/setup.ts`, a `vitest.config.ts` or a shadcn-svelte `components.json`
 * still naming it stops resolving. Each rewrite follows sv's rule
 * (`libSpecifier` from patterns), so the result reads the same as what sv
 * wrote under `src`.
 */

export interface LibRewrite {
	/** Project-relative path of a changed file. */
	file: string;
	/** `old → new` for each specifier changed. */
	changes: string[];
}

export interface LibRewriteResult {
	rewritten: LibRewrite[];
	/** `file: $lib/x` for specifiers with nothing on disk to name. */
	unresolved: string[];
}

/** Extensions a `#lib` specifier keeps as written (sv's rule). */
const KEPT_EXTENSIONS = /\.(svelte|svg|svx|css|json)$/;
const MODULE_EXTENSIONS = ['.ts', '.js', '.mts', '.mjs'];

/**
 * The on-disk name of what `$lib/<rel>` imports, relative to `src/lib`, in
 * the form `libSpecifier` takes: a file by its name, a directory by its path.
 * Null when nothing there matches.
 */
export function resolveLibPath(root: string, rel: string): string | null {
	const lib = path.join(root, 'src', 'lib');
	const isFile = (p: string) =>
		fs.existsSync(path.join(lib, p)) && fs.statSync(path.join(lib, p)).isFile();
	const isDir = (p: string) =>
		fs.existsSync(path.join(lib, p)) && fs.statSync(path.join(lib, p)).isDirectory();

	if (rel === '') return '';
	if (KEPT_EXTENSIONS.test(rel)) {
		// `$lib/x.svelte` can also name `x.svelte.ts`, a rune module.
		if (isFile(rel)) return rel;
		for (const ext of MODULE_EXTENSIONS) if (isFile(rel + ext)) return rel + ext;
		return null;
	}
	if (/\.(ts|js|mts|mjs)$/.test(rel)) {
		if (isFile(rel)) return rel;
		// TypeScript lets `x.js` name `x.ts`.
		const base = rel.replace(/\.(ts|js|mts|mjs)$/, '');
		for (const ext of MODULE_EXTENSIONS) if (isFile(base + ext)) return base + ext;
		return null;
	}
	for (const ext of MODULE_EXTENSIONS) if (isFile(rel + ext)) return rel + ext;
	if (isDir(rel)) return rel;
	return null;
}

/**
 * The `#lib` form of a `$lib` specifier, or null when it names nothing on
 * disk (left alone and reported, rather than guessed at).
 */
export function toLibSpecifier(root: string, specifier: string): string | null {
	if (specifier !== '$lib' && !specifier.startsWith('$lib/')) return null;
	const rel = specifier === '$lib' ? '' : specifier.slice('$lib/'.length).replace(/\/$/, '');
	const onDisk = resolveLibPath(root, rel);
	return onDisk === null ? null : libSpecifier(onDisk);
}

/**
 * Specifiers in module position: `from '…'`, `import '…'`, `import('…')`,
 * and the module argument of `vi.mock`/`vi.doMock`/`vi.importActual`.
 */
const SPECIFIER =
	/(\bfrom\s*|\bimport\s*\(?\s*|\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\s*\(\s*)(['"])(\$lib(?:\/[^'"]*)?)\2/g;

/** Rewrite every `$lib` specifier in `source`. */
export function rewriteLibSpecifiers(
	root: string,
	source: string
): { code: string; changes: string[]; unresolved: string[] } {
	const changes: string[] = [];
	const unresolved: string[] = [];
	const code = source.replace(SPECIFIER, (whole, lead: string, quote: string, spec: string) => {
		const next = toLibSpecifier(root, spec);
		if (!next) {
			unresolved.push(spec);
			return whole;
		}
		changes.push(`${spec} → ${next}`);
		return `${lead}${quote}${next}${quote}`;
	});
	return { code, changes, unresolved };
}

/**
 * Files outside `src/` that import from the app: the server-test setup and
 * anything else under `test/`, the vitest config, and TypeScript or
 * JavaScript at the project root.
 */
export function filesOutsideSrc(root: string): string[] {
	const files: string[] = [];
	const test = path.join(root, 'test');
	if (fs.existsSync(test)) {
		for (const rel of fs.globSync('**/*.{ts,js,mts,mjs,svelte}', {
			cwd: test,
			exclude: (name) => name === 'node_modules'
		})) {
			files.push(path.join(test, rel));
		}
	}
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (
			entry.isFile() &&
			/\.(ts|js|mts|mjs|cts|cjs)$/.test(entry.name) &&
			!entry.name.endsWith('.d.ts')
		) {
			files.push(path.join(root, entry.name));
		}
	}
	return files.filter((f) => fs.statSync(f).isFile()).sort();
}

/** Rewrite `$lib` in the files `filesOutsideSrc` lists. Running it twice changes nothing. */
export function rewriteLibOutsideSrc(root: string): LibRewriteResult {
	const result: LibRewriteResult = { rewritten: [], unresolved: [] };
	for (const file of filesOutsideSrc(root)) {
		const source = fs.readFileSync(file, 'utf8');
		if (!source.includes('$lib')) continue;
		const rel = path.relative(root, file);
		const { code, changes, unresolved } = rewriteLibSpecifiers(root, source);
		result.unresolved.push(...unresolved.map((spec) => `${rel}: ${spec}`));
		if (code === source) continue;
		fs.writeFileSync(file, code);
		result.rewritten.push({ file: rel, changes });
	}
	return result;
}

/**
 * shadcn-svelte's `components.json` aliases. They name directories, not
 * modules, so `$lib/components` becomes `#lib/components` with no `index.js`
 * (shadcn-svelte 1.7 resolves `#lib/*` through package.json `imports`).
 */
export function rewriteComponentsJsonAliases(root: string): LibRewrite | null {
	const file = path.join(root, 'components.json');
	if (!fs.existsSync(file)) return null;
	const source = fs.readFileSync(file, 'utf8');
	let data: unknown;
	try {
		data = JSON.parse(source);
	} catch {
		return null;
	}
	const aliases = (data as { aliases?: unknown }).aliases;
	if (typeof aliases !== 'object' || aliases === null) return null;

	const changes: string[] = [];
	let code = source;
	for (const value of Object.values(aliases as Record<string, unknown>)) {
		if (typeof value !== 'string' || (value !== '$lib' && !value.startsWith('$lib/'))) continue;
		const next = `#lib${value.slice('$lib'.length)}`;
		// Edited as text so the file keeps its formatting.
		code = code.replace(JSON.stringify(value), JSON.stringify(next));
		changes.push(`${value} → ${next}`);
	}
	if (code === source) return null;
	fs.writeFileSync(file, code);
	return { file: 'components.json', changes };
}
