import fs from 'node:fs';
import path from 'node:path';
import {
	Node,
	SyntaxKind,
	ts,
	type ObjectLiteralExpression,
	type PropertyAssignment,
	type SpreadAssignment
} from 'ts-morph';
import {
	createSveltekitArg,
	findSvelteConfig,
	formatLikeSource,
	getOrCreateObjectLiteralProperty,
	inspectViteSveltekit,
	probeFirstExisting,
	VITE_CONFIG_CANDIDATES,
	type ViteSveltekit
} from './config-target.ts';
import { KIT3_MIGRATE_COMMAND } from './kit-version.ts';

export interface MergeOutcome {
	applied: boolean;
	reason: string;
	snippet?: string;
	/** Basename of the config file the merge targeted, for reporting. */
	file?: string;
}

const RUNES_VALUE = `({ filename }) => (filename.split(/[/\\\\]/).includes('node_modules') ? undefined : true)`;

const RUNES_SNIPPET = `\tcompilerOptions: {
\t\trunes: ${RUNES_VALUE}
\t},\n`;

const TAILWIND_IMPORT = `import tailwindcss from '@tailwindcss/vite';`;

/**
 * Ensure the Svelte `runes` compiler option is set, in the inline
 * `sveltekit({...})` argument SvelteKit 3 reads its config from; a bare
 * `sveltekit()` gets an argument created. A leftover svelte.config is a
 * SvelteKit 2 project, and gets the migrate command instead of an edit.
 */
export function mergeSvelteConfig(projectRoot: string): MergeOutcome {
	const svelteConfig = findSvelteConfig(projectRoot);
	if (svelteConfig) return svelteConfigOutcome(svelteConfig);

	const vite = inspectViteSveltekit(projectRoot);
	if (vite?.inlineArg) return mergeRunesIntoViteArg(vite, vite.inlineArg);

	if (vite?.sveltekitCall && !vite.nonObjectArg) {
		const arg = createSveltekitArg(vite);
		if (arg) return mergeRunesIntoViteArg(vite, arg);
	}

	return {
		applied: false,
		reason: 'no sveltekit() call found in a vite.config',
		snippet: RUNES_SNIPPET
	};
}

/**
 * SvelteKit 3 refuses to start while a svelte.config exists, so there is no
 * config to merge into until the project is migrated. The snippet is the
 * command, so a caller that prints snippets surfaces it.
 */
function svelteConfigOutcome(svelteConfig: string): MergeOutcome {
	const file = path.basename(svelteConfig);
	return {
		applied: false,
		reason: `${file} found: SvelteKit 3 reads config only from sveltekit({...}) in vite.config. Migrate the project first`,
		snippet: KIT3_MIGRATE_COMMAND,
		file
	};
}

function mergeRunesIntoViteArg(vite: ViteSveltekit, arg: ObjectLiteralExpression): MergeOutcome {
	const file = path.basename(vite.filePath);
	const compilerOptions = getOrCreateObjectLiteralProperty(arg, 'compilerOptions', '{}');
	if (!compilerOptions) {
		return {
			applied: false,
			reason: 'could not access sveltekit() compilerOptions',
			snippet: RUNES_SNIPPET,
			file
		};
	}
	if (compilerOptions.getProperty('runes')) {
		return { applied: false, reason: 'runes already configured', file };
	}
	compilerOptions.addPropertyAssignment({ name: 'runes', initializer: RUNES_VALUE });
	formatLikeSource(vite.sourceFile);
	vite.sourceFile.saveSync();
	return { applied: true, reason: 'added runes compilerOption', file };
}

const ORIGIN_SPREAD = `...(process.env.VELA_ORIGIN ? { paths: { origin: process.env.VELA_ORIGIN } } : {})`;

/** Where a `prerender.origin` was found, and how to take it out. */
interface OriginSource {
	/** `cond` of a `...(cond ? {...} : {})` spread, when the origin is conditional. */
	condition?: string;
	value: string;
	/** The top-level spread or `prerender` property it lives in, for placing its replacement. */
	anchor: Node;
	remove: () => void;
}

/**
 * Move `prerender.origin`, which SvelteKit 3 removed, to `paths.origin`.
 *
 * vela's Kit 2 templates baked the deploy origin in two ways, and `sv migrate`
 * drops the first without a word and never touches the second:
 *
 * - `...(process.env.VELA_ORIGIN ? { prerender: { origin: process.env.VELA_ORIGIN } } : {})`
 * - `prerender: { handleHttpError, ...(process.env.VELA_ORIGIN ? { origin: process.env.VELA_ORIGIN } : {}) }`
 *
 * Both become `...(process.env.VELA_ORIGIN ? { paths: { origin: process.env.VELA_ORIGIN } } : {})`,
 * or a spread inside `paths` when the config already has a `paths` object a
 * top-level spread would replace. A literal `prerender: { origin: '...' }`
 * moves to `paths.origin` as it is. A `paths.origin` that is already set wins:
 * the stale `prerender.origin` is removed, and the reason says which was kept.
 * Running it again changes nothing.
 */
export function mergeOriginConfig(root: string): MergeOutcome {
	const svelteConfig = findSvelteConfig(root);
	if (svelteConfig) return svelteConfigOutcome(svelteConfig);

	const vite = inspectViteSveltekit(root);
	if (!vite?.inlineArg) {
		return {
			applied: false,
			reason: 'no sveltekit({...}) config, so no prerender.origin to move',
			file: vite ? path.basename(vite.filePath) : undefined
		};
	}
	const file = path.basename(vite.filePath);
	const arg = vite.inlineArg;

	const sources = findPrerenderOrigins(arg);
	const pathsProp = arg.getProperty('paths');
	const paths =
		pathsProp && Node.isPropertyAssignment(pathsProp)
			? pathsProp.getInitializerIfKind(SyntaxKind.ObjectLiteralExpression)
			: undefined;
	const hasPathsOrigin =
		(paths !== undefined && hasOrigin(paths)) ||
		arg.getProperties().some((p) => {
			const spread = conditionalSpreadOf(p, 'paths');
			return spread !== undefined && hasOrigin(spread.object);
		});

	if (sources === 'unsupported') {
		return {
			applied: false,
			reason:
				'prerender.origin is set in a shape vela does not rewrite; SvelteKit 3 removed it, move it to paths.origin',
			snippet: ORIGIN_SPREAD,
			file
		};
	}
	if (sources.length === 0) {
		return {
			applied: false,
			reason: hasPathsOrigin ? 'paths.origin already configured' : 'no prerender.origin to move',
			file
		};
	}
	if (pathsProp && !paths && !hasPathsOrigin) {
		return {
			applied: false,
			reason:
				'`paths` is not an object literal, so vela cannot add origin to it; SvelteKit 3 removed prerender.origin',
			snippet: `origin: ${sources[0]!.value}`,
			file
		};
	}

	const [source] = sources;
	const replacement = source!.condition
		? `...(${source!.condition} ? { paths: { origin: ${source!.value} } } : {})`
		: `paths: { origin: ${source!.value} }`;
	const index = arg.getProperties().indexOf(source!.anchor as never);

	if (hasPathsOrigin) {
		for (const s of sources) s.remove();
	} else if (paths) {
		for (const s of sources) s.remove();
		if (source!.condition) {
			paths.addSpreadAssignment({
				expression: `(${source!.condition} ? { origin: ${source!.value} } : {})`
			});
		} else {
			paths.addPropertyAssignment({ name: 'origin', initializer: source!.value });
		}
	} else if (Node.isSpreadAssignment(source!.anchor)) {
		// The minimal template's shape: swap the spread in place.
		for (const s of sources.slice(1)) s.remove();
		source!.anchor.replaceWithText(replacement);
	} else {
		for (const s of sources) s.remove();
		// After the `prerender` property it came from, or where it was.
		const at = Math.min(
			index + (source!.anchor.wasForgotten() ? 0 : 1),
			arg.getProperties().length
		);
		if (source!.condition) {
			arg.insertSpreadAssignment(at, { expression: replacement.slice(3) });
		} else {
			arg.insertPropertyAssignment(at, {
				name: 'paths',
				initializer: `{ origin: ${source!.value} }`
			});
		}
	}

	vite.sourceFile.saveSync();
	return {
		applied: true,
		reason: hasPathsOrigin
			? 'removed prerender.origin, which SvelteKit 3 no longer accepts; kept the existing paths.origin'
			: 'moved prerender.origin to paths.origin',
		file
	};
}

function unwrap(node: Node): Node {
	let current = node;
	while (Node.isParenthesizedExpression(current)) current = current.getExpression();
	return current;
}

/**
 * `...(cond ? { key: {...} } : {})`: the object under `key` and the condition,
 * when `element` is a conditional spread of exactly that shape.
 */
function conditionalSpreadOf(
	element: Node,
	key: string
): { condition: string; object: ObjectLiteralExpression } | undefined {
	if (!Node.isSpreadAssignment(element)) return undefined;
	const expr = unwrap(element.getExpression());
	if (!Node.isConditionalExpression(expr)) return undefined;
	const whenTrue = unwrap(expr.getWhenTrue());
	const whenFalse = unwrap(expr.getWhenFalse());
	if (!Node.isObjectLiteralExpression(whenTrue) || !Node.isObjectLiteralExpression(whenFalse)) {
		return undefined;
	}
	if (whenFalse.getProperties().length > 0 || whenTrue.getProperties().length !== 1) {
		return undefined;
	}
	const prop = whenTrue.getProperty(key);
	if (!prop) return undefined;
	if (key === 'origin') return { condition: expr.getCondition().getText(), object: whenTrue };
	if (!Node.isPropertyAssignment(prop)) return undefined;
	const object = prop.getInitializerIfKind(SyntaxKind.ObjectLiteralExpression);
	return object ? { condition: expr.getCondition().getText(), object } : undefined;
}

/** The value of an `origin` property, plain or shorthand. */
function originValue(prop: Node): string | undefined {
	if (Node.isPropertyAssignment(prop)) return prop.getInitializer()?.getText();
	if (Node.isShorthandPropertyAssignment(prop)) return prop.getName();
	return undefined;
}

function hasOrigin(object: ObjectLiteralExpression): boolean {
	return object
		.getProperties()
		.some((p) =>
			p.getKind() !== SyntaxKind.SpreadAssignment
				? (p as { getName?: () => string }).getName?.() === 'origin'
				: conditionalSpreadOf(p, 'origin') !== undefined
		);
}

function findPrerenderOrigins(arg: ObjectLiteralExpression): OriginSource[] | 'unsupported' {
	const sources: OriginSource[] = [];
	for (const element of arg.getProperties()) {
		// `...(cond ? { prerender: { origin } } : {})`
		const spread = conditionalSpreadOf(element, 'prerender');
		if (spread) {
			const props = spread.object.getProperties();
			const value =
				props.length === 1 && props[0]!.getKind() !== SyntaxKind.SpreadAssignment
					? originValue(props[0]!)
					: undefined;
			if (!value || (props[0] as { getName?: () => string }).getName?.() !== 'origin') {
				return 'unsupported';
			}
			sources.push({
				condition: spread.condition,
				value,
				anchor: element,
				remove: () => element.remove()
			});
			continue;
		}

		if (!Node.isPropertyAssignment(element) || element.getName() !== 'prerender') continue;
		const prerender = element.getInitializerIfKind(SyntaxKind.ObjectLiteralExpression);
		if (!prerender) continue;
		const removeFromPrerender = (node: { remove(): void }) => () => {
			node.remove();
			if (prerender.getProperties().length === 0) element.remove();
		};
		for (const inner of prerender.getProperties()) {
			// `prerender: { ...(cond ? { origin } : {}) }`
			const conditional = conditionalSpreadOf(inner, 'origin');
			if (conditional) {
				const value = originValue(conditional.object.getPropertyOrThrow('origin'));
				if (!value) return 'unsupported';
				sources.push({
					condition: conditional.condition,
					value,
					anchor: element,
					remove: removeFromPrerender(inner as SpreadAssignment)
				});
				continue;
			}
			// `prerender: { origin: '...' }`
			if (
				!Node.isSpreadAssignment(inner) &&
				(inner as { getName?: () => string }).getName?.() === 'origin'
			) {
				const value = originValue(inner);
				if (!value) return 'unsupported';
				sources.push({
					value,
					anchor: element,
					remove: removeFromPrerender(inner as PropertyAssignment)
				});
			}
		}
	}
	return sources;
}

export function mergeViteConfig(filePath: string): MergeOutcome {
	if (!fs.existsSync(filePath)) {
		return {
			applied: false,
			reason: 'vite.config.ts not found',
			snippet: `${TAILWIND_IMPORT}\n// then add tailwindcss() to the plugins array`
		};
	}

	const original = fs.readFileSync(filePath, 'utf8');
	if (original.includes('@tailwindcss/vite')) {
		return { applied: false, reason: 'tailwindcss plugin already present' };
	}

	const pluginsMatch = original.match(/plugins\s*:\s*\[/);
	if (!pluginsMatch || pluginsMatch.index === undefined) {
		return {
			applied: false,
			reason: 'vite.config.ts has a non-standard shape — no plugins array found',
			snippet: `import tailwindcss from '@tailwindcss/vite';\n// plugins: [tailwindcss(), sveltekit()]`
		};
	}

	const withImport = addImport(original, TAILWIND_IMPORT);

	const newPluginsMatch = withImport.match(/plugins\s*:\s*\[/)!;
	const insertAt = newPluginsMatch.index! + newPluginsMatch[0].length;
	const trailing = withImport.slice(insertAt);
	const prefix = /^\s*\]/.test(trailing) ? 'tailwindcss()' : 'tailwindcss(), ';
	const updated = withImport.slice(0, insertAt) + prefix + withImport.slice(insertAt);

	fs.writeFileSync(filePath, updated);
	return { applied: true, reason: 'added @tailwindcss/vite plugin' };
}

export interface TsconfigOptions {
	/** The project has PocketBase, whose generated types live outside `src`. */
	backend: boolean;
}

const APP_TSCONFIG = '$app/tsconfig';
/** What Kit 2 projects extended; SvelteKit 3 generates `$app/tsconfig` instead. */
const GENERATED_TSCONFIG = /(^|\/)\.svelte-kit\/tsconfig\.json$/;
const POCKETBASE_TYPES = '.svelte-kit/types/pocketbase/*.d.ts';
const VITEST_CONFIG_CANDIDATES = [
	'vitest.config.ts',
	'vitest.config.js',
	'vitest.config.mts',
	'vitest.config.mjs'
];

/**
 * Bring tsconfig.json to what SvelteKit 3 expects of a vela project. It extends
 * `$app/tsconfig` (replacing Kit 2's `.svelte-kit/tsconfig.json`) and, since
 * the generated config no longer lists files, owns `include`: `src`, `test`
 * and the vitest config when they exist, the vite config, and PocketBase's
 * generated types when there is a backend. `rewriteRelativeImportExtensions`,
 * which Kit 2 projects set for the server tests, is dropped. Entries already
 * there stay, in their order.
 *
 * Parsed as JSON, not patched as text. A file with comments would lose them on
 * a rewrite, so it is left alone and the snippet is the file vela would write.
 */
export function mergeTsconfig(root: string, { backend }: TsconfigOptions): MergeOutcome {
	const file = 'tsconfig.json';
	const filePath = path.join(root, file);
	if (!fs.existsSync(filePath)) {
		return { applied: false, reason: 'tsconfig.json not found', file };
	}
	const original = fs.readFileSync(filePath, 'utf8');

	let data: unknown;
	let plainJson = true;
	try {
		data = JSON.parse(original);
	} catch {
		plainJson = false;
		const parsed = ts.parseConfigFileTextToJson(filePath, original);
		if (parsed.error) return { applied: false, reason: 'tsconfig.json could not be parsed', file };
		data = parsed.config;
	}
	if (!isObject(data)) return { applied: false, reason: 'tsconfig.json is not an object', file };

	const changes: string[] = [];
	let config: Record<string, unknown> = structuredClone(data);

	const extended = config.extends;
	if (extended === undefined) {
		config = { extends: APP_TSCONFIG, ...config };
		changes.push(`extends ${APP_TSCONFIG}`);
	} else {
		const list = Array.isArray(extended) ? [...extended] : [extended];
		const index = list.findIndex((e) => typeof e === 'string' && GENERATED_TSCONFIG.test(e));
		if (index !== -1) {
			list[index] = APP_TSCONFIG;
			config.extends = Array.isArray(extended) ? list : APP_TSCONFIG;
			changes.push(`extends ${APP_TSCONFIG}`);
		} else if (!list.includes(APP_TSCONFIG)) {
			return {
				applied: false,
				reason: `tsconfig.json extends ${JSON.stringify(extended)}; SvelteKit 3 needs it to extend "${APP_TSCONFIG}"`,
				snippet: `"extends": ${JSON.stringify([APP_TSCONFIG, ...list])}`,
				file
			};
		}
	}

	const compilerOptions = config.compilerOptions;
	if (isObject(compilerOptions) && 'rewriteRelativeImportExtensions' in compilerOptions) {
		delete compilerOptions.rewriteRelativeImportExtensions;
		changes.push('dropped rewriteRelativeImportExtensions');
	}

	const wanted = ['src'];
	if (fs.existsSync(path.join(root, 'test'))) wanted.push('test');
	wanted.push(path.basename(probeFirstExisting(root, VITE_CONFIG_CANDIDATES) ?? 'vite.config.ts'));
	const vitest = probeFirstExisting(root, VITEST_CONFIG_CANDIDATES);
	if (vitest) wanted.push(path.basename(vitest));
	if (backend) wanted.push(POCKETBASE_TYPES);

	const include = config.include ?? [];
	if (!Array.isArray(include)) {
		return {
			applied: false,
			reason: 'tsconfig.json has an include that is not an array',
			snippet: `"include": ${JSON.stringify(wanted)}`,
			file
		};
	}
	const normalize = (entry: unknown) =>
		typeof entry === 'string' ? entry.replace(/^\.\//, '').replace(/\/$/, '') : entry;
	const present = new Set(include.map(normalize));
	const missing = wanted.filter((entry) => !present.has(entry));
	if (missing.length > 0) {
		config.include = [...include, ...missing];
		changes.push(`include ${missing.join(', ')}`);
	}

	if (changes.length === 0) {
		return { applied: false, reason: 'tsconfig.json already set up for SvelteKit 3', file };
	}

	const updated = `${stringifyJson(config, detectJsonIndent(original))}\n`;
	if (!plainJson) {
		return {
			applied: false,
			reason: `tsconfig.json has comments vela would lose by rewriting it; make these changes by hand: ${changes.join('; ')}`,
			snippet: updated,
			file
		};
	}
	fs.writeFileSync(filePath, updated);
	return { applied: true, reason: changes.join('; '), file };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The indent of the first indented line, a tab when there is none. */
function detectJsonIndent(source: string): string {
	return source.match(/\n([ \t]+)\S/)?.[1] ?? '\t';
}

/** prettier's default print width, which the templates keep. */
const PRINT_WIDTH = 100;

/**
 * JSON the way prettier leaves it: objects one key per line, arrays of
 * scalars on one line when they fit. `JSON.stringify` puts every array element
 * on its own line, which a project's `prettier --check` would then fail.
 */
function stringifyJson(value: unknown, indent: string, level = 0, prefix = 0): string {
	const pad = (n: number) => indent.repeat(n);
	// prettier counts a tab as its default tabWidth, 2.
	const width = (text: string) => text.replaceAll('\t', '  ').length;
	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';
		const scalars = value.every((v) => v === null || typeof v !== 'object');
		const inline = `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
		// +1 for a trailing comma after it.
		if (scalars && prefix + width(inline) + 1 <= PRINT_WIDTH) return inline;
		const items = value.map(
			(v) => pad(level + 1) + stringifyJson(v, indent, level + 1, width(pad(level + 1)))
		);
		return `[\n${items.join(',\n')}\n${pad(level)}]`;
	}
	if (isObject(value)) {
		const entries = Object.entries(value);
		if (entries.length === 0) return '{}';
		const lines = entries.map(([key, v]) => {
			const head = `${pad(level + 1)}${JSON.stringify(key)}: `;
			return head + stringifyJson(v, indent, level + 1, width(head));
		});
		return `{\n${lines.join(',\n')}\n${pad(level)}}`;
	}
	return JSON.stringify(value);
}

const GITIGNORE_ENTRIES = [
	'.env',
	'.env.*',
	'!.env.example',
	'!.env.test',
	'vite.config.js.timestamp-*',
	'vite.config.ts.timestamp-*',
	// The local database, minus the parts that are source. Same block as the
	// template's _gitignore; without it a blessed project commits its SQLite.
	'/data/*',
	'!/data/fixtures',
	'!/data/seeds',
	'!/data/hooks',
	'/backups'
];

export function mergeGitignore(filePath: string): MergeOutcome {
	const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
	const lines = existing.split('\n').map((l) => l.trim());
	const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry));
	if (missing.length === 0) {
		return { applied: false, reason: '.gitignore already has vela entries' };
	}

	const needsNewline = existing.length > 0 && !existing.endsWith('\n');
	const appended = `${existing}${needsNewline ? '\n' : ''}${missing.join('\n')}\n`;
	fs.writeFileSync(filePath, appended);
	return { applied: true, reason: `added ${missing.length} gitignore entries` };
}

function addImport(source: string, importLine: string): string {
	if (source.includes(importLine)) return source;
	const importRegex = /^import\s[^\n]+;?\s*$/gm;
	let lastImportEnd = 0;
	let match: RegExpExecArray | null;
	while ((match = importRegex.exec(source)) !== null) {
		lastImportEnd = match.index + match[0].length;
	}
	if (lastImportEnd === 0) {
		return `${importLine}\n${source}`;
	}
	return source.slice(0, lastImportEnd) + `\n${importLine}` + source.slice(lastImportEnd);
}
