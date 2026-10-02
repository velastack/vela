import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { Node, SyntaxKind, type Expression, type ObjectLiteralExpression } from 'ts-morph';
import { inspectViteSveltekit } from './config-target.ts';
import { readPackageJson, sortKeys, writePackageJson, type PkgJson } from './package-json.ts';

/**
 * `ssr.external` in vite.config, checked against what the server installs.
 *
 * adapter-node 5 re-bundled `build/server` in a rollup pass of its own, which
 * inlined everything but production `dependencies`, so a devDependency listed
 * in `ssr.external` was harmless. adapter-node 6 (SvelteKit 3) builds the
 * server in Vite's one pass: its plugin externalizes `dependencies` and
 * bundles the rest, but the project's own `ssr.external` entries still win.
 * A devDependency listed there stays a bare import in the output, and the
 * server, which installs production dependencies only, fails every page that
 * imports it with ERR_MODULE_NOT_FOUND.
 */

export type SsrExternalCheck =
	/** No vite config, or no `ssr.external` in it. */
	| { kind: 'none' }
	/**
	 * A literal list. `missing` are the entries the server will not install:
	 * devDependencies that are not also dependencies. Node builtins and
	 * packages the project does not list at all are left out.
	 */
	| { kind: 'list'; file: string; entries: string[]; missing: string[] }
	/** `ssr.external: true`, which adapter-node 6 overrides by bundling everything (see ssrExternalAllNotice). */
	| { kind: 'all'; file: string }
	/** Something vela cannot read without running the config. Never a reason to fail. */
	| { kind: 'unknown'; file: string; reason: string };

/** `@scope/name/sub` → `@scope/name`, `name/sub` → `name`: what package.json lists. */
export function packageNameOf(specifier: string): string {
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/** Peel `defineConfig(...)`, parentheses, `as` and `satisfies` off an expression. */
function unwrap(expr: Expression | undefined): Expression | undefined {
	let current = expr;
	for (let i = 0; current && i < 10; i++) {
		if (Node.isParenthesizedExpression(current) || Node.isAsExpression(current)) {
			current = current.getExpression();
		} else if (Node.isSatisfiesExpression(current)) {
			current = current.getExpression();
		} else if (
			Node.isCallExpression(current) &&
			current.getExpression().getText() === 'defineConfig'
		) {
			current = current.getArguments()[0] as Expression | undefined;
		} else if (Node.isIdentifier(current)) {
			const decl = current
				.getSourceFile()
				.getVariableDeclaration(current.getText())
				?.getInitializer();
			if (!decl) return current;
			current = decl;
		} else {
			return current;
		}
	}
	return current;
}

/** The object the config file exports, when it is one vela can read without running it. */
function exportedConfig(expr: Expression | undefined): ObjectLiteralExpression | string {
	const value = unwrap(expr);
	if (!value) return 'it has no default export';
	if (Node.isObjectLiteralExpression(value)) return value;
	if (Node.isArrowFunction(value) || Node.isFunctionExpression(value)) {
		return 'its config is a function';
	}
	return 'its default export is not an object literal';
}

/**
 * The entries of the top-level `ssr.external` in `vite.config.*` that the
 * server will not have at runtime: listed in devDependencies, not in
 * dependencies. Reads the config without running it, and never throws: a
 * config it cannot read is `unknown`.
 */
export function ssrExternalNotInDependencies(root: string): SsrExternalCheck {
	let vite;
	try {
		vite = inspectViteSveltekit(root);
	} catch (err) {
		return { kind: 'unknown', file: 'vite.config', reason: (err as Error).message };
	}
	if (!vite) return { kind: 'none' };
	const file = path.basename(vite.filePath);
	const unknown = (reason: string): SsrExternalCheck => ({ kind: 'unknown', file, reason });

	try {
		const assignment = vite.sourceFile.getExportAssignment((d) => !d.isExportEquals());
		const config = exportedConfig(assignment?.getExpression());
		if (typeof config === 'string') return unknown(config);

		const ssrProp = config.getProperty('ssr');
		if (!ssrProp) return { kind: 'none' };
		if (!Node.isPropertyAssignment(ssrProp)) return unknown('`ssr` is not a plain property');
		const ssr = unwrap(ssrProp.getInitializer());
		if (!ssr || !Node.isObjectLiteralExpression(ssr)) {
			return unknown('`ssr` is not an object literal');
		}

		const externalProp = ssr.getProperty('external');
		if (!externalProp) return { kind: 'none' };
		if (!Node.isPropertyAssignment(externalProp)) {
			return unknown('`ssr.external` is not a plain property');
		}
		const external = unwrap(externalProp.getInitializer());
		if (!external) return unknown('`ssr.external` has no value');
		if (external.getKind() === SyntaxKind.TrueKeyword) return { kind: 'all', file };
		if (!Node.isArrayLiteralExpression(external)) {
			return unknown('`ssr.external` is not an array literal');
		}

		const entries: string[] = [];
		for (const element of external.getElements()) {
			if (Node.isStringLiteral(element) || Node.isNoSubstitutionTemplateLiteral(element)) {
				entries.push(element.getLiteralValue());
			} else {
				return unknown(`\`ssr.external\` has an entry that is not a string: ${element.getText()}`);
			}
		}

		const pkgPath = path.join(root, 'package.json');
		const pkg: PkgJson = fs.existsSync(pkgPath) ? readPackageJson(pkgPath) : {};
		const missing = entries
			.filter((entry) => !isBuiltin(entry))
			.map(packageNameOf)
			.filter((name) => !pkg.dependencies?.[name] && pkg.devDependencies?.[name] !== undefined);
		return { kind: 'list', file, entries, missing: [...new Set(missing)] };
	} catch (err) {
		return unknown((err as Error).message);
	}
}

/**
 * Move `names` from devDependencies to dependencies, keeping each range.
 * Mutates `pkg`; returns the names it moved.
 */
export function moveToDependencies(pkg: PkgJson, names: string[]): string[] {
	const moved: string[] = [];
	for (const name of names) {
		const range = pkg.devDependencies?.[name];
		if (range === undefined || pkg.dependencies?.[name] !== undefined) continue;
		pkg.dependencies = sortKeys({ ...pkg.dependencies, [name]: range });
		delete pkg.devDependencies![name];
		moved.push(name);
	}
	return moved;
}

/** `moveToDependencies` on the project's package.json, written only when something moved. */
export function moveSsrExternalsToDependencies(root: string, names: string[]): string[] {
	const pkgPath = path.join(root, 'package.json');
	const pkg = readPackageJson(pkgPath);
	const moved = moveToDependencies(pkg, names);
	if (moved.length > 0) writePackageJson(pkgPath, pkg);
	return moved;
}

/**
 * Why a devDependency in `ssr.external` breaks an adapter-node 6 server, or
 * null when nothing listed is missing. `vela deploy` fails on it and
 * `vela build` warns.
 */
export function ssrExternalProblem(check: SsrExternalCheck): string | null {
	if (check.kind !== 'list' || check.missing.length === 0) return null;
	const names = check.missing.join(', ');
	const one = check.missing.length === 1;
	return (
		`${check.file} lists ${names} in ssr.external, but ${one ? 'it is a devDependency' : 'they are devDependencies'}.\n` +
		`adapter-node 6 builds the server in one Vite pass and leaves ssr.external imports\n` +
		`unbundled, and the server installs production dependencies only, so every page that\n` +
		`imports ${one ? 'it' : 'one'} fails with ERR_MODULE_NOT_FOUND.\n\n` +
		`Move ${one ? 'it' : 'them'} to dependencies, or drop ${one ? 'it' : 'them'} from ssr.external.`
	);
}

/**
 * `ssr.external: true` under adapter-node 6. Vite merges it over the
 * adapter's list as `true`, and the adapter's `noExternal: true` then wins,
 * so everything is bundled, production dependencies included: nothing goes
 * missing at runtime, and the setting does nothing. Worth removing, not
 * worth failing a deploy over.
 */
export function ssrExternalAllNotice(check: SsrExternalCheck): string | null {
	if (check.kind !== 'all') return null;
	return (
		`${check.file} sets ssr.external: true, which adapter-node 6 overrides: it bundles the\n` +
		`whole server, dependencies included. Drop it, or list only the packages that must stay\n` +
		`external (each in dependencies).`
	);
}
