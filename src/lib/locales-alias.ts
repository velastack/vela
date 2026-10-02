import fs from 'node:fs';
import path from 'node:path';
import { Node, SyntaxKind, type ObjectLiteralExpression } from 'ts-morph';
import { ensurePackageImports } from '@velastack/patterns';
import { inspectViteSveltekit } from './config-target.ts';
import { sourceFiles } from './vela-env.ts';

/**
 * `alias: { $locales: 'src/locales' }` → a `#locales/*` package.json import.
 *
 * SvelteKit 3 deprecates `alias`, and patterns' i18n (0.4) maps wuchale's
 * output directory the way `#lib` is mapped. A project that enabled i18n on
 * SvelteKit 2 has the alias, and `$locales/data`-style specifiers without an
 * extension; package imports resolve files, not modules, so each gets the
 * file's real name: `main.url.js`, `main.loader.svelte.js`, `data.js`.
 * Only this alias is converted; any other stays a follow-up.
 */

/** The entry patterns' i18n writes (its LOCALES_IMPORTS). */
export const LOCALES_IMPORTS = { '#locales/*': './src/locales/*' };

const LOCALES_DIR = 'src/locales';

export interface LocalesAliasOutcome {
	changed: boolean;
	details: string[];
	warnings: string[];
}

/** A key without its quotes: `$locales` and `'$locales'` alike. */
function keyName(node: Node): string | undefined {
	if (!Node.isPropertyAssignment(node)) return undefined;
	return node
		.getNameNode()
		.getText()
		.replace(/^['"`]|['"`]$/g, '');
}

function localesProperty(alias: ObjectLiteralExpression) {
	return alias.getProperties().find((p) => keyName(p) === '$locales');
}

/** `#locales/<rest>` with the file's real name: `.js` (or `.svelte.js`) added when it is missing. */
export function localesSpecifier(root: string, rest: string): string {
	if (/\.(?:js|mjs|cjs|json)$/.test(rest)) return `#locales/${rest}`;
	const dir = path.join(root, LOCALES_DIR);
	const exists = (name: string) => fs.existsSync(path.join(dir, name));
	if (!exists(`${rest}.js`) && (exists(`${rest}.svelte.js`) || exists(`${rest}.svelte.ts`))) {
		return `#locales/${rest}.svelte.js`;
	}
	return `#locales/${rest}.js`;
}

const LOCALES_SPECIFIER = /(['"])\$locales\/([^'"\n]+)\1/g;

/** Every quoted `$locales/...` specifier in `source`, rewritten. */
export function rewriteLocalesSource(
	root: string,
	source: string
): { code: string; changes: string[] } {
	const changes: string[] = [];
	const code = source.replace(LOCALES_SPECIFIER, (_whole, quote: string, rest: string) => {
		const next = localesSpecifier(root, rest);
		changes.push(`$locales/${rest} → ${next}`);
		return `${quote}${next}${quote}`;
	});
	return { code, changes };
}

/**
 * Convert the inline config's `alias.$locales`, when it points at
 * `src/locales`: the package.json import, every specifier under `src/` and
 * `test/`, then the alias entry (and `alias`, once empty). Running it again
 * finds no alias and changes nothing.
 */
export async function migrateLocalesAlias(root: string): Promise<LocalesAliasOutcome> {
	const outcome: LocalesAliasOutcome = { changed: false, details: [], warnings: [] };
	const vite = inspectViteSveltekit(root);
	const aliasProp = vite?.inlineArg?.getProperty('alias');
	if (!vite || !aliasProp || !Node.isPropertyAssignment(aliasProp)) return outcome;
	const alias = aliasProp.getInitializerIfKind(SyntaxKind.ObjectLiteralExpression);
	const entry = alias && localesProperty(alias);
	if (!alias || !entry || !Node.isPropertyAssignment(entry)) return outcome;
	const target = entry.getInitializerIfKind(SyntaxKind.StringLiteral)?.getLiteralValue();
	const normalized = target?.replace(/^\.\//, '').replace(/\/$/, '');
	if (normalized !== LOCALES_DIR) return outcome;

	const imports = await ensurePackageImports(root, LOCALES_IMPORTS);
	if (imports.outcome.status !== 'success') {
		outcome.warnings.push(
			`alias.$locales was left in place: ${imports.outcome.message ?? 'package.json imports could not be updated'}`
		);
		return outcome;
	}
	if (imports.outcome.changed) {
		outcome.changed = true;
		outcome.details.push('package.json imports #locales/*');
	}

	const files = [...sourceFiles(path.join(root, 'src')), ...sourceFiles(path.join(root, 'test'))];
	let rewritten = 0;
	for (const file of files) {
		const source = fs.readFileSync(file, 'utf8');
		if (!source.includes('$locales/')) continue;
		const { code, changes } = rewriteLocalesSource(root, source);
		if (code === source) continue;
		fs.writeFileSync(file, code);
		rewritten += changes.length;
		outcome.details.push(`${path.relative(root, file)}: ${[...new Set(changes)].join(', ')}`);
	}

	entry.remove();
	if (alias.getProperties().length === 0) aliasProp.remove();
	vite.sourceFile.saveSync();
	outcome.changed = true;
	outcome.details.push(
		`${path.basename(vite.filePath)}: removed alias.$locales${rewritten ? ` (${rewritten} specifier${rewritten === 1 ? '' : 's'} now #locales)` : ''}`
	);
	return outcome;
}
