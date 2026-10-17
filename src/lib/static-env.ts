import fs from 'node:fs';
import path from 'node:path';
import { ENV_DECL_CANDIDATES } from '@velastack/patterns';
import { Node, Project, QuoteKind, type Expression, type SourceFile } from 'ts-morph';
import { kitMajor } from './kit-version.ts';

/**
 * Which of a project's environment variables are baked into the build.
 *
 * Setting one of those on the server changes nothing until the next deploy,
 * and a build that cannot see one fails or ships the developer's value. Both
 * are worth knowing before the command that would otherwise report a restart,
 * or upload a bundle with a dev value in it.
 *
 * What makes a variable static depends on the SvelteKit major:
 *
 * - Kit 3 decides by declaration. A variable is baked only when its entry in
 *   `src/env.ts` says `static: true`. The `$env/static/*` modules still exist
 *   but are deprecated aliases of `$app/env/*`, so an import path says nothing.
 * - Kit 2 decided by import path: anything imported from `$env/static/*`.
 *
 * `vela env set` runs on either, so the rule follows the project.
 */

export interface StaticEnv {
	names: Set<string>;
	/** How a name got here, for the message that names it. */
	rule: 'declarations' | 'imports';
	/** Finishes "X is …": `declared static: true in src/env.ts`, `imported from $env/static`. */
	how: string;
	/** Finishes "… or …": what the developer removes to make the variable a runtime one. */
	remedy: string;
}

/** The project's build-time variables, by the rule its SvelteKit uses. */
export function staticEnv(root: string): StaticEnv {
	const major = kitMajor(root);
	if (major !== null && major < 3) {
		return {
			names: staticEnvImports(root),
			rule: 'imports',
			how: 'imported from $env/static',
			remedy: 'remove the import'
		};
	}
	const file = findEnvDecl(root);
	const rel = file ? path.relative(root, file).split(path.sep).join('/') : ENV_DECL_CANDIDATES[0]!;
	return {
		names: file ? staticEnvDeclarations(file) : new Set(),
		rule: 'declarations',
		how: `declared static: true in ${rel}`,
		remedy: 'drop static: true'
	};
}

/** `src/env.ts` or `src/env.js`, whichever the project has. */
function findEnvDecl(root: string): string | null {
	for (const rel of ENV_DECL_CANDIDATES) {
		const abs = path.join(root, rel);
		if (fs.existsSync(abs)) return abs;
	}
	return null;
}

/**
 * The names whose entry in a `src/env.ts` literally says `static: true`.
 *
 * Kit runs this file through Vite, so a declaration could be computed
 * (`static: isProd`) or spread in from elsewhere. A text read cannot evaluate
 * those, so they count as runtime: at worst a changed value reports
 * "restarted" when it needed a deploy. vela's own generators only ever write
 * the literal.
 */
export function staticEnvDeclarations(file: string): Set<string> {
	const names = new Set<string>();
	let sf: SourceFile;
	try {
		const project = new Project({
			compilerOptions: { allowJs: true },
			skipFileDependencyResolution: true,
			manipulationSettings: { quoteKind: QuoteKind.Single }
		});
		sf = project.addSourceFileAtPath(file);
	} catch {
		return names;
	}
	const object = variablesObject(sf);
	if (!object) return names;
	for (const prop of object.getProperties()) {
		if (!Node.isPropertyAssignment(prop)) continue;
		const name = literalName(prop.getNameNode());
		const entry = unwrap(prop.getInitializer());
		if (!name || !entry || !Node.isObjectLiteralExpression(entry)) continue;
		for (const field of entry.getProperties()) {
			if (!Node.isPropertyAssignment(field)) continue;
			if (literalName(field.getNameNode()) !== 'static') continue;
			const value = unwrap(field.getInitializer());
			if (value && Node.isTrueLiteral(value)) names.add(name);
		}
	}
	return names;
}

/**
 * The object `variables` is built from: `export const variables =
 * defineEnvVars({ ... })`, or the same with a plain object literal. The
 * shapes `@velastack/patterns` edits, located the same way.
 */
function variablesObject(sf: SourceFile) {
	let local = 'variables';
	for (const decl of sf.getExportDeclarations()) {
		for (const spec of decl.getNamedExports()) {
			const exported = spec.getAliasNode()?.getText() ?? spec.getName();
			if (exported !== 'variables') continue;
			if (decl.getModuleSpecifier()) return null;
			local = spec.getName();
		}
	}
	const init = unwrap(sf.getVariableDeclaration(local)?.getInitializer());
	if (!init) return null;
	if (Node.isObjectLiteralExpression(init)) return init;
	if (Node.isCallExpression(init) && init.getExpression().getText() === 'defineEnvVars') {
		const arg = unwrap(init.getArguments()[0] as Expression | undefined);
		if (arg && Node.isObjectLiteralExpression(arg)) return arg;
	}
	return null;
}

/** A property name as Kit sees it: `FOO`, `'FOO'` or `['FOO']`; null for anything computed. */
function literalName(node: Node): string | null {
	if (Node.isComputedPropertyName(node)) {
		const inner = node.getExpression();
		return Node.isStringLiteral(inner) || Node.isNoSubstitutionTemplateLiteral(inner)
			? inner.getLiteralText()
			: null;
	}
	if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
		return node.getLiteralText();
	return Node.isIdentifier(node) ? node.getText() : null;
}

function unwrap(expr: Expression | undefined): Expression | undefined {
	let current = expr;
	while (
		current &&
		(Node.isParenthesizedExpression(current) ||
			Node.isAsExpression(current) ||
			Node.isSatisfiesExpression(current))
	) {
		current = current.getExpression();
	}
	return current;
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.mts', '.mjs', '.svelte']);

const STATIC_IMPORT =
	/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]\$env\/static\/(?:private|public)['"]/g;

/**
 * The names a project imports from `$env/static/*`: SvelteKit 2's rule, where
 * the module decided and those were read once, at build time.
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
