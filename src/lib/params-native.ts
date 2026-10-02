import fs from 'node:fs';
import path from 'node:path';
import { Project, QuoteKind, type ImportDeclaration } from 'ts-morph';

/**
 * SvelteKit 3.0.0 loads `src/params.ts` (or `.js`) with Node's own
 * `import()` at build time, not through Vite. So what it imports has to
 * resolve the way Node resolves it:
 *
 * - `#lib/x.js` goes through package.json `imports` to `./src/lib/x.js`,
 *   which is not there when the file is `x.ts`: those become relative
 *   imports with the real extension (`./lib/x.ts`; SvelteKit's tsconfig sets
 *   `allowImportingTsExtensions`);
 * - a type imported without `type` is a value import of something that does
 *   not exist at runtime. sv's params task reprints the matchers' imports
 *   and drops the `type` modifier (`import { isCountryCode, type
 *   CountryCode }` came out as `{ isCountryCode, CountryCode }`), so it is
 *   restored from the matchers sv read, or from what the imported file
 *   declares.
 */

export const PARAMS_FILES = ['src/params.ts', 'src/params.js'];

const PARAMS_DIR = 'src/params';
const IMPORT_SPECIFIERS = /import\s+(type\s+)?([^'";]*?)\s*from\s*(['"])([^'"]+)\3/g;

/**
 * The local names `src/params/*` imports as types (`import type { A }`,
 * `{ type B }`), read before sv folds the matchers into `src/params.ts`.
 */
export function captureParamTypeImports(root: string): Set<string> {
	const names = new Set<string>();
	const dir = path.join(root, PARAMS_DIR);
	if (!fs.existsSync(dir)) return names;
	for (const entry of fs.readdirSync(dir)) {
		if (!/\.(ts|js)$/.test(entry)) continue;
		const source = fs.readFileSync(path.join(dir, entry), 'utf8');
		for (const match of source.matchAll(IMPORT_SPECIFIERS)) {
			const clause = match[2]!;
			const braces = clause.match(/\{([^}]*)\}/)?.[1];
			if (!braces) continue;
			for (const raw of braces.split(',')) {
				const spec = raw.trim();
				const inline = /^type\s+/.test(spec);
				if (!spec || (!match[1] && !inline)) continue;
				const [, local] = spec.replace(/^type\s+/, '').match(/^(?:[\w$]+\s+as\s+)?([\w$]+)$/) ?? [];
				if (local) names.add(local);
			}
		}
	}
	return names;
}

export interface ParamsOutcome {
	/** Project-relative params file, when there is one. */
	file?: string;
	changes: string[];
	/** Modules params.ts loads that import something only Vite resolves, `file: specifier`. */
	viteOnly: string[];
}

/** The file a local specifier names, from `fromDir`: `#lib/x.js`, `./x.js`, `../lib/x`. */
function resolveLocal(root: string, fromDir: string, spec: string): string | null {
	let base: string;
	if (spec.startsWith('#lib/') || spec.startsWith('$lib/')) {
		base = path.join(root, 'src', 'lib', spec.slice(5));
	} else if (spec.startsWith('./') || spec.startsWith('../')) {
		base = path.resolve(fromDir, spec);
	} else {
		return null;
	}
	const stem = base.replace(/\.js$/, '');
	const candidates = /\.js$/.test(base)
		? [base, `${stem}.ts`]
		: [base, `${base}.ts`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.js')];
	return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

/** Whether `file` declares `name` as a type only: `export type`/`interface`, or a JSDoc `@typedef`. */
function declaresTypeOnly(file: string, name: string): boolean {
	const source = fs.readFileSync(file, 'utf8');
	const n = name.replace(/[$]/g, '\\$');
	const asValue = new RegExp(
		String.raw`\bexport\s+(?:declare\s+)?(?:const|let|var|function|class|enum|async\s+function)\s+${n}\b|\bexport\s*\{[^}]*\b${n}\b`
	);
	if (asValue.test(source)) return false;
	return new RegExp(
		String.raw`\bexport\s+(?:declare\s+)?(?:type|interface)\s+${n}\b|@(?:typedef|callback)\s+(?:\{[\s\S]*?\}\s+)?${n}\b`
	).test(source);
}

/** A specifier for `target` that Node resolves from `src/`: relative, with the file's real name. */
function relativeSpecifier(root: string, target: string): string {
	const rel = path.relative(path.join(root, 'src'), target).split(path.sep).join('/');
	return rel.startsWith('.') ? rel : `./${rel}`;
}

/**
 * Make `src/params.ts` loadable by Node: `#lib` imports of `.ts` files as
 * relative `.ts` paths, and `type` back on what is only a type (`typeNames`
 * from `captureParamTypeImports`, plus what the imported file declares).
 * Also lists anything params.ts pulls in that only Vite resolves. Running it
 * again changes nothing.
 */
export function fixParamsImports(root: string, typeNames: Set<string> = new Set()): ParamsOutcome {
	const rel = PARAMS_FILES.find((f) => fs.existsSync(path.join(root, f)));
	if (!rel) return { changes: [], viteOnly: [] };
	const file = path.join(root, rel);
	const outcome: ParamsOutcome = { file: rel, changes: [], viteOnly: [] };

	const project = new Project({
		compilerOptions: { allowJs: true },
		manipulationSettings: { quoteKind: QuoteKind.Single }
	});
	const sourceFile = project.addSourceFileAtPath(file);
	const srcDir = path.join(root, 'src');
	const loaded: string[] = [];

	for (const decl of sourceFile.getImportDeclarations()) {
		const spec = decl.getModuleSpecifierValue();
		const target = resolveLocal(root, srcDir, spec);
		if (!target) continue;
		if (!decl.isTypeOnly()) restoreTypes(decl, target, typeNames, outcome);
		// Erased before Node sees it, wherever it points.
		if (decl.isTypeOnly()) continue;
		loaded.push(target);
		const nodeResolves =
			spec.startsWith('#lib/') && /\.js$/.test(spec)
				? fs.existsSync(path.join(root, 'src', 'lib', spec.slice(5)))
				: spec.startsWith('.') && path.resolve(srcDir, spec) === target;
		if (nodeResolves) continue;
		const next = relativeSpecifier(root, target);
		decl.setModuleSpecifier(next);
		outcome.changes.push(`${spec} → ${next}`);
	}

	if (outcome.changes.length > 0) sourceFile.saveSync();
	outcome.viteOnly = viteOnlyImports(root, loaded);
	return outcome;
}

/** Put `type` back on named imports that are only types. */
function restoreTypes(
	decl: ImportDeclaration,
	target: string,
	typeNames: Set<string>,
	outcome: ParamsOutcome
): void {
	const named = decl.getNamedImports();
	const restored: string[] = [];
	for (const specifier of named) {
		if (specifier.isTypeOnly()) continue;
		const local = specifier.getAliasNode()?.getText() ?? specifier.getName();
		if (!typeNames.has(local) && !declaresTypeOnly(target, specifier.getName())) continue;
		specifier.setIsTypeOnly(true);
		restored.push(local);
	}
	if (restored.length === 0) return;
	// Node keeps `import { type A } from './x.ts'` as a load of x.ts; a
	// declaration that is all types has to be `import type` to go away.
	if (
		named.every((s) => s.isTypeOnly()) &&
		!decl.getDefaultImport() &&
		!decl.getNamespaceImport()
	) {
		for (const s of named) s.setIsTypeOnly(false);
		decl.setIsTypeOnly(true);
	}
	outcome.changes.push(`type ${restored.join(', ')} (from ${decl.getModuleSpecifierValue()})`);
}

/** Value imports, in the modules params.ts loads and theirs, that Node cannot resolve. */
function viteOnlyImports(root: string, start: string[]): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	const queue = [...start];
	for (let file = queue.shift(); file; file = queue.shift()) {
		if (seen.has(file) || !file.startsWith(path.join(root, 'src'))) continue;
		seen.add(file);
		const source = fs.readFileSync(file, 'utf8');
		const rel = path.relative(root, file).split(path.sep).join('/');
		for (const match of source.matchAll(IMPORT_SPECIFIERS)) {
			const clause = match[2]!;
			const spec = match[4]!;
			// Type-only imports are erased before Node sees them.
			if (match[1] || /^\{\s*(?:type\s+[\w$]+(?:\s+as\s+[\w$]+)?\s*,?\s*)+\}$/.test(clause))
				continue;
			if (/^\$(?:lib|app|env|locales|service-worker)\b/.test(spec)) {
				found.push(`${rel}: ${spec}`);
				continue;
			}
			const target = resolveLocal(root, path.dirname(file), spec);
			if (spec.startsWith('#lib/')) {
				if (!fs.existsSync(path.join(root, 'src', 'lib', spec.slice(5)))) {
					found.push(`${rel}: ${spec}`);
				}
			} else if (
				spec.startsWith('.') &&
				target &&
				path.resolve(path.dirname(file), spec) !== target
			) {
				found.push(`${rel}: ${spec}`);
			}
			if (target) queue.push(target);
		}
	}
	return found;
}
