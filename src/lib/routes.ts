import fs from 'node:fs';
import path from 'node:path';
import { SyntaxKind, ts } from 'ts-morph';
import { inspectViteSveltekit } from './config-target.ts';

/**
 * The project's routes, read from the files under its routes directory.
 *
 * SvelteKit builds this list itself (`create_manifest_data`), but only inside
 * a Vite process and through modules it does not export, so vela reads the
 * directory by the same rules instead. The rules followed are SvelteKit 3's:
 *
 * - a route file starts with `+`; `+page@group.svelte` is still a page
 * - `*.test.*`, `*.spec.*`, `*.stories.*` and `*.d.ts` beside a route are not
 *   route files
 * - a page component has one of the configured `extensions` (`.svx`, `.md`),
 *   not only `.svelte`
 * - a symlinked directory is walked like any other
 * - an endpoint answers the methods `+server` exports, `QUERY` included
 */

export interface Route {
	/** The route id SvelteKit uses: `/(public)/blog/[slug]`. */
	id: string;
	/** The id as a visitor's URL, groups dropped: `/blog/[slug]`. */
	urlPattern: string;
	methods: string[];
	/**
	 * A page a visitor navigates to, as opposed to an endpoint. As in
	 * SvelteKit, a `+page.server.ts` on its own counts: that is how a route
	 * that only redirects is written.
	 */
	page: boolean;
}

/** What `+server` may export, as in SvelteKit's `ENDPOINT_METHODS`, plus `fallback`. */
export const ENDPOINT_METHODS = [
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
	'OPTIONS',
	'HEAD',
	'QUERY',
	'fallback'
];

const MODULE_EXTENSIONS = ['.js', '.ts'];
const DEFAULT_EXTENSIONS = ['.svelte'];

// The two patterns `create_manifest_data` classifies a route file with.
const COMPONENT_NAME = /^\+(?:(page(?:@(.*))?)|(layout(?:@(.*))?)|(error))$/;
const MODULE_NAME =
	/^\+(?:(server)|(page(?:(@[a-zA-Z0-9_-]*))?(\.server)?)|(layout(?:(@[a-zA-Z0-9_-]*))?(\.server)?))$/;

export interface RouteConfig {
	/** Routes directory, relative to the project root. */
	routesDir: string;
	/**
	 * Component extensions from `sveltekit({ extensions })`, or null when the
	 * config builds the list at run time and it cannot be read from the source.
	 */
	extensions: string[] | null;
}

/**
 * Where the routes are and which extensions a page may have, from the inline
 * `sveltekit({...})` config. Anything that is not a literal there falls back
 * to SvelteKit's default.
 */
export function readRouteConfig(root: string): RouteConfig {
	const fallback: RouteConfig = {
		routesDir: path.join('src', 'routes'),
		extensions: DEFAULT_EXTENSIONS
	};

	let arg;
	try {
		arg = inspectViteSveltekit(root)?.inlineArg;
	} catch {
		return fallback;
	}
	if (!arg) return fallback;

	const initializer = (object: typeof arg, name: string) => {
		const prop = object.getProperty(name);
		return prop?.isKind(SyntaxKind.PropertyAssignment) ? prop.getInitializer() : undefined;
	};
	const stringOf = (node: ReturnType<typeof initializer>) =>
		node?.isKind(SyntaxKind.StringLiteral) || node?.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)
			? node.getLiteralValue()
			: undefined;

	const files = initializer(arg, 'files')?.asKind(SyntaxKind.ObjectLiteralExpression);
	const src = (files && stringOf(initializer(files, 'src'))) ?? 'src';
	const routesDir = (files && stringOf(initializer(files, 'routes'))) ?? path.join(src, 'routes');

	let extensions: string[] | null = DEFAULT_EXTENSIONS;
	const declared = initializer(arg, 'extensions');
	if (declared) {
		const literals = declared
			.asKind(SyntaxKind.ArrayLiteralExpression)
			?.getElements()
			.map((element) => stringOf(element));
		extensions =
			literals && literals.every((value) => value !== undefined) ? (literals as string[]) : null;
	}

	return { routesDir: path.normalize(routesDir), extensions };
}

type RouteFile =
	/** The page component, or its universal `+page.ts`. */
	| { kind: 'page' }
	| { kind: 'page-server' }
	| { kind: 'endpoint' }
	/** A layout, error page or universal module: part of the tree, not a route. */
	| { kind: 'other' };

/** What a file in a route directory is to the router, or null when it is not a route file. */
export function classifyRouteFile(name: string, extensions: string[] | null): RouteFile | null {
	if (!name.startsWith('+')) return null;
	if (name.includes('.test.') || name.includes('.spec.') || name.includes('.stories.')) return null;
	if (name.endsWith('.d.ts')) return null;

	const componentExt = (extensions ?? DEFAULT_EXTENSIONS).find((ext) => name.endsWith(ext));
	if (componentExt) {
		const match = COMPONENT_NAME.exec(name.slice(0, -componentExt.length));
		if (!match) return null;
		return match[1] ? { kind: 'page' } : { kind: 'other' };
	}

	const moduleExt = MODULE_EXTENSIONS.find((ext) => name.endsWith(ext));
	if (moduleExt) {
		const match = MODULE_NAME.exec(name.slice(0, -moduleExt.length));
		if (!match) return null;
		if (match[1]) return { kind: 'endpoint' };
		if (match[2]) return { kind: match[4] ? 'page-server' : 'page' };
		return { kind: 'other' };
	}

	// The extensions could not be read from the config, so a `+page.<ext>` that
	// is neither a module nor `.svelte` is taken to be one of them (`.svx`).
	if (extensions === null && /^\+page(@[^.]*)?(\.[a-z0-9]+)+$/i.test(name)) {
		return { kind: 'page' };
	}
	return null;
}

/**
 * The names a module exports, whichever way it spells them: a declaration,
 * a destructured declaration, `export { a as b }`, or a re-export.
 */
export function exportedNames(source: string, fileName = 'module.ts'): string[] {
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false);
	const names: string[] = [];

	const bindingNames = (name: ts.BindingName) => {
		if (ts.isIdentifier(name)) {
			names.push(name.text);
			return;
		}
		for (const element of name.elements) {
			if (ts.isBindingElement(element)) bindingNames(element.name);
		}
	};
	const exported = (node: ts.Node) =>
		ts.canHaveModifiers(node) &&
		ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

	for (const statement of file.statements) {
		if (ts.isExportDeclaration(statement)) {
			const clause = statement.exportClause;
			if (clause && ts.isNamedExports(clause)) {
				for (const element of clause.elements) names.push(element.name.text);
			}
			continue;
		}
		if (!exported(statement)) continue;
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				bindingNames(declaration.name);
			}
		} else if (ts.isFunctionDeclaration(statement) && statement.name) {
			names.push(statement.name.text);
		}
	}
	return names;
}

function readExports(file: string): string[] {
	try {
		return exportedNames(fs.readFileSync(file, 'utf8'), path.basename(file));
	} catch {
		return [];
	}
}

/** `[x+2e]` and `[u+1f600]` in a route id are the characters they encode. */
function decodeEscapes(segment: string): string {
	return segment.replace(/\[([ux])\+([0-9a-f]+)\]/g, (_match, type: string, code: string) =>
		type === 'x'
			? String.fromCharCode(parseInt(code, 16))
			: String.fromCodePoint(parseInt(code, 16))
	);
}

const isGroup = (segment: string) => /^\([^)]+\)$/.test(segment);

function segmentsOf(id: string): string[] {
	return id.split('/').filter((segment) => segment !== '' && !isGroup(segment));
}

/** A route id as the URL it answers: groups dropped, escapes decoded. */
export function routeUrl(id: string): string {
	return '/' + segmentsOf(id).map(decodeEscapes).join('/');
}

export function listRoutes(root: string, config: RouteConfig = readRouteConfig(root)): Route[] {
	const routesRoot = path.join(root, config.routesDir);
	if (!fs.existsSync(routesRoot)) return [];

	const routes: Route[] = [];

	const walk = (dir: string, id: string) => {
		const entries = fs
			.readdirSync(dir, { withFileTypes: true })
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

		const methods = new Set<string>();
		let page = false;
		const subdirs: string[] = [];

		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			let isDir = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					isDir = fs.statSync(full).isDirectory();
				} catch {
					continue; // a dangling link
				}
			}
			if (isDir) {
				subdirs.push(entry.name);
				continue;
			}

			const file = classifyRouteFile(entry.name, config.extensions);
			if (file?.kind === 'page') {
				page = true;
				methods.add('GET');
			} else if (file?.kind === 'page-server') {
				page = true;
				methods.add('GET');
				if (readExports(full).includes('actions')) methods.add('POST');
			} else if (file?.kind === 'endpoint') {
				for (const name of readExports(full)) {
					if (ENDPOINT_METHODS.includes(name)) methods.add(name);
				}
			}
		}

		if (methods.size > 0) {
			routes.push({
				id,
				urlPattern: routeUrl(id),
				methods: ENDPOINT_METHODS.filter((method) => methods.has(method)),
				page
			});
		}
		for (const name of subdirs) {
			walk(path.join(dir, name), id === '/' ? `/${name}` : `${id}/${name}`);
		}
	};

	walk(routesRoot, '/');
	return routes.sort(
		(a, b) => a.urlPattern.localeCompare(b.urlPattern) || a.id.localeCompare(b.id)
	);
}
